"""Turn raw provider traffic into ModelCall records.

Each parser is keyed on the request URL. Bodies come in as bytes so streamed
(SSE) and plain JSON replies share one entry point.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

from .protocol import ModelCall, Provider, Usage, Wire

PROVIDER_HOSTS: dict[str, Provider] = {
    "api.openai.com": "openai",
    "api.anthropic.com": "anthropic",
    "generativelanguage.googleapis.com": "gemini",
}

# The provider family each wire belongs to, for hosts we do not recognise
# (a gateway, a compatible endpoint).
WIRE_PROVIDER: dict[Wire, Provider] = {
    "responses": "openai",
    "completions": "openai",
    "anthropic": "anthropic",
    "gemini": "gemini",
}


def provider_for_host(host: str) -> Provider | None:
    for suffix, provider in PROVIDER_HOSTS.items():
        if host == suffix or host.endswith("." + suffix):
            return provider
    return None


def wire_for_path(path: str) -> Wire | None:
    if path.endswith("/responses"):
        return "responses"
    if path.endswith("/chat/completions"):
        return "completions"
    if path.endswith("/messages"):
        return "anthropic"
    if ":generateContent" in path or ":streamGenerateContent" in path:
        return "gemini"
    return None


def is_model_call(url: str) -> bool:
    return wire_for_path(urlparse(url).path) is not None


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _sse_json_events(body: bytes) -> list[dict[str, Any]]:
    """Every `data:` payload in an SSE body that parses as a JSON object."""
    events: list[dict[str, Any]] = []
    for block in body.decode("utf-8", errors="replace").split("\n\n"):
        data_lines = [
            line[5:].strip() for line in block.split("\n") if line.startswith("data:")
        ]
        if not data_lines:
            continue
        payload = "\n".join(data_lines)
        if payload == "[DONE]":
            continue
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def _json_or_none(body: bytes) -> Any:
    try:
        return json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def usage_from_openai_responses(usage: dict[str, Any]) -> Usage:
    return Usage(
        input=_int(usage.get("input_tokens")),
        cached_input=_int(
            (usage.get("input_tokens_details") or {}).get("cached_tokens")
        ),
        output=_int(usage.get("output_tokens")),
        reasoning_output=_int(
            (usage.get("output_tokens_details") or {}).get("reasoning_tokens")
        ),
    )


def usage_from_openai_completions(usage: dict[str, Any]) -> Usage:
    return Usage(
        input=_int(usage.get("prompt_tokens")),
        cached_input=_int(
            (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
        ),
        output=_int(usage.get("completion_tokens")),
        reasoning_output=_int(
            (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
        ),
    )


def usage_from_anthropic(usage: dict[str, Any]) -> Usage:
    # Anthropic's input_tokens excludes cache reads and writes; ours includes them.
    fresh = _int(usage.get("input_tokens"))
    cached = _int(usage.get("cache_read_input_tokens"))
    written = _int(usage.get("cache_creation_input_tokens"))
    return Usage(
        input=fresh + cached + written,
        cached_input=cached,
        cache_write_input=written,
        output=_int(usage.get("output_tokens")),
    )


def usage_from_gemini(usage: dict[str, Any]) -> Usage:
    return Usage(
        input=_int(usage.get("promptTokenCount")),
        cached_input=_int(usage.get("cachedContentTokenCount")),
        output=_int(usage.get("candidatesTokenCount"))
        + _int(usage.get("thoughtsTokenCount")),
        reasoning_output=_int(usage.get("thoughtsTokenCount")),
    )


def _parse_responses(
    body: bytes, streamed: bool
) -> tuple[Usage | None, str | None, str | None]:
    if streamed:
        for event in reversed(_sse_json_events(body)):
            response = event.get("response")
            if event.get("type") == "response.completed" and isinstance(response, dict):
                usage = response.get("usage") or {}
                return (
                    usage_from_openai_responses(usage),
                    response.get("model"),
                    response.get("service_tier"),
                )
        return None, None, None
    data = _json_or_none(body)
    if not isinstance(data, dict):
        return None, None, None
    usage = data.get("usage")
    return (
        usage_from_openai_responses(usage) if isinstance(usage, dict) else None,
        data.get("model"),
        data.get("service_tier"),
    )


def _parse_completions(
    body: bytes, streamed: bool
) -> tuple[Usage | None, str | None, str | None]:
    if streamed:
        model = None
        tier = None
        for event in _sse_json_events(body):
            model = event.get("model") or model
            tier = event.get("service_tier") or tier
            usage = event.get("usage")
            if isinstance(usage, dict) and usage:
                return usage_from_openai_completions(usage), model, tier
        return None, model, tier
    data = _json_or_none(body)
    if not isinstance(data, dict):
        return None, None, None
    usage = data.get("usage")
    return (
        usage_from_openai_completions(usage) if isinstance(usage, dict) else None,
        data.get("model"),
        data.get("service_tier"),
    )


def _parse_anthropic(
    body: bytes, streamed: bool
) -> tuple[Usage | None, str | None, str | None]:
    if streamed:
        merged: dict[str, Any] = {}
        model = None
        for event in _sse_json_events(body):
            kind = event.get("type")
            if kind == "message_start":
                message = event.get("message") or {}
                model = message.get("model") or model
                merged.update(message.get("usage") or {})
            elif kind == "message_delta":
                # message_delta usage is cumulative for output and, on newer
                # API versions, repeats the input counts; later values win.
                merged.update(event.get("usage") or {})
        if not merged:
            return None, model, None
        return usage_from_anthropic(merged), model, None
    data = _json_or_none(body)
    if not isinstance(data, dict):
        return None, None, None
    usage = data.get("usage")
    return (
        usage_from_anthropic(usage) if isinstance(usage, dict) else None,
        data.get("model"),
        None,
    )


def _parse_gemini(
    body: bytes, streamed: bool
) -> tuple[Usage | None, str | None, str | None]:
    chunks: list[dict[str, Any]]
    if streamed:
        chunks = _sse_json_events(body)
        if not chunks:
            data = _json_or_none(body)
            chunks = (
                [c for c in data if isinstance(c, dict)]
                if isinstance(data, list)
                else []
            )
    else:
        data = _json_or_none(body)
        chunks = [data] if isinstance(data, dict) else []
    usage = None
    model = None
    for chunk in chunks:
        model = chunk.get("modelVersion") or model
        if isinstance(chunk.get("usageMetadata"), dict):
            usage = usage_from_gemini(chunk["usageMetadata"])
    return usage, model, None


def _gemini_model_from_path(path: str) -> str | None:
    marker = "/models/"
    if marker not in path:
        return None
    rest = path.split(marker, 1)[1]
    return rest.split(":", 1)[0] or None


def parse_call(
    *,
    url: str,
    request_body: bytes,
    response_body: bytes,
    status: int,
    content_type: str,
    duration_ms: int,
) -> ModelCall | None:
    parsed = urlparse(url)
    wire = wire_for_path(parsed.path)
    if wire is None:
        return None
    host = parsed.hostname or ""
    provider = provider_for_host(host) or WIRE_PROVIDER[wire]
    request = _json_or_none(request_body)
    request = request if isinstance(request, dict) else {}
    streamed = "text/event-stream" in content_type or bool(request.get("stream"))

    if wire == "responses":
        usage, model, tier = _parse_responses(response_body, streamed)
    elif wire == "completions":
        usage, model, tier = _parse_completions(response_body, streamed)
    elif wire == "anthropic":
        usage, model, tier = _parse_anthropic(response_body, streamed)
    else:
        usage, model, tier = _parse_gemini(response_body, streamed)
        model = model or _gemini_model_from_path(parsed.path)

    model = model or str(request.get("model") or "")
    if not model:
        raise ValueError(f"model call to {url} names no model in request or response")
    return ModelCall(
        provider=provider,
        host=host,
        model=model,
        wire=wire,
        usage=usage,
        duration_ms=duration_ms,
        service_tier=tier or request.get("service_tier"),
        status=status,
        request_bytes=len(request_body),
        response_bytes=len(response_body),
        streamed=streamed,
    )
