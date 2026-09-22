import json

import httpx
import pytest
from context_cup_engine.recorder import Recorder

PLAIN = json.dumps(
    {"model": "gpt-5.5", "usage": {"prompt_tokens": 3, "completion_tokens": 4}}
)
STREAM = (
    b'data: {"model":"gpt-5.5","choices":[{"delta":{"content":"a"}}]}\n\n'
    b'data: {"model":"gpt-5.5","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n'
    b"data: [DONE]\n\n"
)


class ChunkedStream(httpx.SyncByteStream, httpx.AsyncByteStream):
    """Yields the body in small pieces, like a real socket would."""

    def __init__(self, body: bytes, size: int = 16) -> None:
        self._body = body
        self._size = size

    def __iter__(self):
        for i in range(0, len(self._body), self._size):
            yield self._body[i : i + self._size]

    async def __aiter__(self):
        for chunk in self:
            yield chunk


def handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/v1/gzip/chat/completions":
        import gzip

        return httpx.Response(
            200,
            headers={"content-type": "application/json", "content-encoding": "gzip"},
            stream=ChunkedStream(gzip.compress(PLAIN.encode())),
        )
    if request.url.path == "/v1/models":
        return httpx.Response(200, json={"data": []})
    body = json.loads(request.content or b"{}")
    if body.get("stream"):
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=ChunkedStream(STREAM),
        )
    return httpx.Response(
        200, headers={"content-type": "application/json"}, content=PLAIN
    )


@pytest.fixture
def recorder():
    r = Recorder()
    r.install()
    try:
        yield r
    finally:
        r.uninstall()


def test_sync_plain_and_streamed_and_ignored(recorder: Recorder):
    with httpx.Client(
        transport=httpx.MockTransport(handler), base_url="https://api.openai.com"
    ) as client:
        client.get("/v1/models")
        client.post("/v1/chat/completions", json={"model": "gpt-5.5"})
        with client.stream(
            "POST", "/v1/chat/completions", json={"model": "gpt-5.5", "stream": True}
        ) as r:
            consumed = b"".join(r.iter_bytes())
    assert consumed == STREAM
    calls = recorder.drain()
    assert [c.streamed for c in calls] == [False, True]
    assert calls[0].usage.input == 3 and calls[1].usage.input == 9
    assert calls[1].response_bytes == len(STREAM)
    assert recorder.drain() == []


def test_stream_closed_early_still_records(recorder: Recorder):
    with (
        httpx.Client(
            transport=httpx.MockTransport(handler), base_url="https://api.openai.com"
        ) as client,
        client.stream(
            "POST", "/v1/chat/completions", json={"model": "gpt-5.5", "stream": True}
        ) as r,
    ):
        next(r.iter_bytes(chunk_size=8))
    calls = recorder.drain()
    assert len(calls) == 1
    # Partial body: no usage event seen, but the call is not lost.
    assert calls[0].usage is None and calls[0].streamed is True
    assert 0 < calls[0].response_bytes < len(STREAM)


@pytest.mark.asyncio
async def test_async_client(recorder: Recorder):
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://api.openai.com"
    ) as client:
        await client.post("/v1/chat/completions", json={"model": "gpt-5.5"})
        async with client.stream(
            "POST", "/v1/chat/completions", json={"model": "gpt-5.5", "stream": True}
        ) as r:
            async for _ in r.aiter_bytes():
                pass
    calls = recorder.drain()
    assert [c.usage.input for c in calls] == [3, 9]


def test_purpose_tag_applies_to_calls_made_while_set(recorder: Recorder):
    with httpx.Client(
        transport=httpx.MockTransport(handler), base_url="https://api.openai.com"
    ) as client:
        recorder.purpose = "summarize"
        client.post("/v1/chat/completions", json={"model": "gpt-5.5"})
        recorder.purpose = "turn"
        client.post("/v1/chat/completions", json={"model": "gpt-5.5"})
    assert [c.purpose for c in recorder.drain()] == ["summarize", "turn"]


def test_uninstall_restores_httpx(recorder: Recorder):
    recorder.uninstall()
    with httpx.Client(
        transport=httpx.MockTransport(handler), base_url="https://api.openai.com"
    ) as client:
        client.post("/v1/chat/completions", json={"model": "gpt-5.5"})
    assert recorder.drain() == []
    recorder.install()


def test_gzip_encoded_body_is_decoded_before_parsing(recorder: Recorder):
    with httpx.Client(
        transport=httpx.MockTransport(handler), base_url="https://api.openai.com"
    ) as client:
        r = client.post("/v1/gzip/chat/completions", json={"model": "gpt-5.5"})
    assert r.json()["usage"]["prompt_tokens"] == 3, "client still sees decoded JSON"
    calls = recorder.drain()
    assert calls[0].usage.input == 3 and calls[0].usage.output == 4
