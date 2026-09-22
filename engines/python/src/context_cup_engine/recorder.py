"""Record every model call a process makes, below the client libraries.

The OpenAI, Anthropic and Google SDKs and litellm all send through httpx, so
the choke point is `httpx.Client._send_single_request` (and the async twin):
every request passes through it exactly once, before the body is read, and
regardless of the transport in use. The response's byte stream is replaced
with a tee that copies bytes as the client consumes them and, when the stream
is exhausted or closed, hands the full body to the parsers.

Nothing here changes what the client sees.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import zlib
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx

from .parsers import is_model_call, parse_call
from .protocol import ModelCall


class Recorder:
    """Collects ModelCall records for the lifetime of the process."""

    def __init__(self) -> None:
        self.calls: list[ModelCall] = []
        self.purpose = "turn"
        self._lock = threading.Lock()
        self._installed = False
        self._originals: dict[str, Any] = {}

    def record(self, call: ModelCall) -> None:
        call.purpose = self.purpose
        with self._lock:
            self.calls.append(call)

    def drain(self) -> list[ModelCall]:
        with self._lock:
            calls, self.calls = self.calls, []
        return calls

    # -- patching ----------------------------------------------------------

    def install(self) -> None:
        if self._installed:
            return
        recorder = self
        sync_original = httpx.Client._send_single_request
        async_original = httpx.AsyncClient._send_single_request

        def sync_patched(
            client: httpx.Client, request: httpx.Request
        ) -> httpx.Response:
            started = time.monotonic()
            response = sync_original(client, request)
            _attach(recorder, request, response, started)
            return response

        async def async_patched(
            client: httpx.AsyncClient, request: httpx.Request
        ) -> httpx.Response:
            started = time.monotonic()
            response = await async_original(client, request)
            _attach(recorder, request, response, started)
            return response

        self._originals = {"sync": sync_original, "async": async_original}
        setattr(httpx.Client, "_send_single_request", sync_patched)  # noqa: B010
        setattr(httpx.AsyncClient, "_send_single_request", async_patched)  # noqa: B010
        self._installed = True

    def uninstall(self) -> None:
        if not self._installed:
            return
        setattr(httpx.Client, "_send_single_request", self._originals["sync"])  # noqa: B010
        setattr(httpx.AsyncClient, "_send_single_request", self._originals["async"])  # noqa: B010
        self._installed = False


def _attach(
    recorder: Recorder, request: httpx.Request, response: httpx.Response, started: float
) -> None:
    url = str(request.url)
    if not is_model_call(url):
        return
    try:
        request_body = request.content
    except httpx.RequestNotRead:
        request_body = b""
    context = _CallContext(
        recorder=recorder,
        url=url,
        request_body=request_body,
        status=response.status_code,
        content_type=response.headers.get("content-type", ""),
        content_encoding=response.headers.get("content-encoding", ""),
        started=started,
    )
    if hasattr(response, "_content"):
        # The body was already materialised (a transport that hands back
        # content, not a stream): nothing further will flow, record it now.
        context.chunks.append(response.content)
        context.finish()
        return
    stream = response.stream
    if isinstance(stream, httpx.AsyncByteStream):
        response.stream = _AsyncTee(stream, context)
    elif isinstance(stream, httpx.SyncByteStream):
        response.stream = _SyncTee(stream, context)


class _CallContext:
    def __init__(
        self,
        *,
        recorder: Recorder,
        url: str,
        request_body: bytes,
        status: int,
        content_type: str,
        content_encoding: str,
        started: float,
    ) -> None:
        self.recorder = recorder
        self.url = url
        self.request_body = request_body
        self.status = status
        self.content_type = content_type
        self.content_encoding = content_encoding
        self.started = started
        self.chunks: list[bytes] = []
        self.done = False

    def finish(self) -> None:
        if self.done:
            return
        self.done = True
        # The tee sits below httpx's content decoding, so it sees the bytes as
        # they came off the wire.
        response_body = decode_body(b"".join(self.chunks), self.content_encoding)
        try:
            call = parse_call(
                url=self.url,
                request_body=self.request_body,
                response_body=response_body,
                status=self.status,
                content_type=self.content_type,
                duration_ms=int((time.monotonic() - self.started) * 1000),
            )
        except ValueError as exc:
            # Surfaces in the turn's stderr.txt; the client is not disturbed.
            print(f"[recorder] dropped call: {exc}", file=sys.stderr)
            return
        if call is not None:
            self.recorder.record(call)
            _save_bodies(self.recorder, self.url, self.request_body, response_body)


def decode_body(body: bytes, content_encoding: str) -> bytes:
    """Undo transfer compression. Unknown encodings come back untouched."""
    encoding = content_encoding.strip().lower()
    if not body or encoding in ("", "identity"):
        return body
    try:
        if encoding == "gzip":
            return zlib.decompress(body, zlib.MAX_WBITS | 16)
        if encoding == "deflate":
            try:
                return zlib.decompress(body)
            except zlib.error:
                return zlib.decompress(body, -zlib.MAX_WBITS)
        if encoding == "br":
            import brotli

            return bytes(brotli.decompress(body))
        if encoding == "zstd":
            import zstandard

            return bytes(zstandard.ZstdDecompressor().decompressobj().decompress(body))
    except Exception:  # noqa: BLE001 - a body we cannot decode is recorded raw
        return body
    return body


def _save_bodies(recorder: Recorder, url: str, request: bytes, response: bytes) -> None:
    """With CC_SAVE_BODIES=1, keep every request and response body under the
    turn directory (calls/NNN_request.json, NNN_response.txt): the cassette."""
    if os.environ.get("CC_SAVE_BODIES") != "1":
        return
    turn_dir = os.environ.get("CC_TURN_DIR")
    if not turn_dir:
        return
    calls_dir = Path(turn_dir) / "calls"
    calls_dir.mkdir(parents=True, exist_ok=True)
    index = len(recorder.calls)
    (calls_dir / f"{index:03d}_request.json").write_bytes(request)
    (calls_dir / f"{index:03d}_response.txt").write_bytes(
        f"{url}\n\n".encode() + response
    )


class _SyncTee(httpx.SyncByteStream):
    def __init__(self, inner: httpx.SyncByteStream, context: _CallContext) -> None:
        self._inner = inner
        self._context = context

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self._inner:
            self._context.chunks.append(chunk)
            yield chunk
        self._context.finish()

    def close(self) -> None:
        try:
            self._inner.close()
        finally:
            self._context.finish()


class _AsyncTee(httpx.AsyncByteStream):
    def __init__(self, inner: httpx.AsyncByteStream, context: _CallContext) -> None:
        self._inner = inner
        self._context = context

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._inner:
            self._context.chunks.append(chunk)
            yield chunk
        self._context.finish()

    async def aclose(self) -> None:
        try:
            await self._inner.aclose()
        finally:
            self._context.finish()


_global: Recorder | None = None


def global_recorder() -> Recorder:
    global _global
    if _global is None:
        _global = Recorder()
    return _global
