import json

from context_cup_engine.parsers import parse_call


def sse(*events: dict) -> bytes:
    return (
        "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode()
        + b"data: [DONE]\n\n"
    )


def call(url: str, request: dict, body: bytes, content_type: str = "application/json"):
    return parse_call(
        url=url,
        request_body=json.dumps(request).encode(),
        response_body=body,
        status=200,
        content_type=content_type,
        duration_ms=12,
    )


def test_openai_responses_plain():
    body = json.dumps(
        {
            "model": "gpt-5.5-2026-01-01",
            "service_tier": "default",
            "usage": {
                "input_tokens": 100,
                "input_tokens_details": {"cached_tokens": 60},
                "output_tokens": 30,
                "output_tokens_details": {"reasoning_tokens": 10},
            },
        }
    ).encode()
    c = call("https://api.openai.com/v1/responses", {"model": "gpt-5.5"}, body)
    assert c.provider == "openai" and c.wire == "responses"
    assert c.model == "gpt-5.5-2026-01-01"
    assert c.usage.model_dump() == {
        "input": 100,
        "cached_input": 60,
        "cache_write_input": 0,
        "output": 30,
        "reasoning_output": 10,
    }
    assert c.streamed is False and c.status == 200


def test_openai_responses_streamed_takes_completed_event():
    body = sse(
        {"type": "response.created", "response": {"model": "gpt-5.5"}},
        {"type": "response.output_text.delta", "delta": "hi"},
        {
            "type": "response.completed",
            "response": {
                "model": "gpt-5.5",
                "usage": {"input_tokens": 5, "output_tokens": 7},
            },
        },
    )
    c = call(
        "https://api.openai.com/v1/responses",
        {"model": "gpt-5.5", "stream": True},
        body,
        "text/event-stream",
    )
    assert c.streamed is True
    assert c.usage.input == 5 and c.usage.output == 7


def test_openai_completions_streamed_without_usage_is_recorded_without_usage():
    body = sse({"model": "gpt-5.5", "choices": [{"delta": {"content": "x"}}]})
    c = call(
        "https://api.openai.com/v1/chat/completions",
        {"model": "gpt-5.5", "stream": True},
        body,
        "text/event-stream",
    )
    assert c.wire == "completions" and c.usage is None and c.model == "gpt-5.5"


def test_openai_completions_plain():
    body = json.dumps(
        {
            "model": "gpt-5.5",
            "usage": {
                "prompt_tokens": 40,
                "completion_tokens": 8,
                "prompt_tokens_details": {"cached_tokens": 16},
                "completion_tokens_details": {"reasoning_tokens": 2},
            },
        }
    ).encode()
    c = call("https://api.openai.com/v1/chat/completions", {"model": "gpt-5.5"}, body)
    assert (
        c.usage.input,
        c.usage.cached_input,
        c.usage.output,
        c.usage.reasoning_output,
    ) == (
        40,
        16,
        8,
        2,
    )


def test_anthropic_plain_includes_cache_in_input():
    body = json.dumps(
        {
            "model": "claude-sonnet-4-6",
            "usage": {
                "input_tokens": 10,
                "cache_read_input_tokens": 90,
                "cache_creation_input_tokens": 5,
                "output_tokens": 3,
            },
        }
    ).encode()
    c = call(
        "https://api.anthropic.com/v1/messages", {"model": "claude-sonnet-4-6"}, body
    )
    assert c.provider == "anthropic" and c.wire == "anthropic"
    assert c.usage.input == 105 and c.usage.cached_input == 90
    assert c.usage.cache_write_input == 5 and c.usage.output == 3


def test_anthropic_streamed_merges_start_and_delta():
    body = (
        b'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":20,"cache_read_input_tokens":4,"output_tokens":1}}}\n\n'
        b'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n'
    )
    c = call(
        "https://api.anthropic.com/v1/messages",
        {"model": "claude-sonnet-4-6", "stream": True},
        body,
        "text/event-stream",
    )
    assert c.model == "claude-sonnet-4-6"
    assert c.usage.input == 24 and c.usage.cached_input == 4 and c.usage.output == 42


def test_gemini_plain_and_model_from_path():
    body = json.dumps(
        {
            "usageMetadata": {
                "promptTokenCount": 50,
                "candidatesTokenCount": 9,
                "thoughtsTokenCount": 4,
                "cachedContentTokenCount": 20,
            }
        }
    ).encode()
    c = call(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent",
        {},
        body,
    )
    assert c.provider == "gemini" and c.wire == "gemini" and c.model == "gemini-3.1-pro"
    assert c.usage.input == 50 and c.usage.cached_input == 20
    assert c.usage.output == 13 and c.usage.reasoning_output == 4


def test_gemini_streamed_takes_last_usage():
    body = sse(
        {"usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 1}},
        {
            "modelVersion": "gemini-3.1-pro-001",
            "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 9},
        },
    )
    c = call(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse",
        {},
        body,
        "text/event-stream",
    )
    assert c.model == "gemini-3.1-pro-001" and c.usage.output == 9


def test_unknown_host_takes_the_provider_from_the_wire_and_keeps_the_host():
    body = json.dumps(
        {"model": "some-model", "usage": {"prompt_tokens": 1, "completion_tokens": 2}}
    ).encode()
    c = call(
        "https://gateway.example.invalid/v1/chat/completions", {"model": "x"}, body
    )
    assert c.provider == "openai" and c.wire == "completions"
    assert c.host == "gateway.example.invalid"


def test_known_host_is_recorded():
    body = json.dumps(
        {"model": "gpt-5.5", "usage": {"prompt_tokens": 1, "completion_tokens": 2}}
    ).encode()
    c = call("https://api.openai.com/v1/chat/completions", {"model": "gpt-5.5"}, body)
    assert c.host == "api.openai.com"


def test_call_without_a_model_is_a_protocol_error():
    import pytest

    with pytest.raises(ValueError, match="names no model"):
        call("https://api.openai.com/v1/chat/completions", {}, b"{}")


def test_non_model_url_is_ignored():
    assert call("https://api.openai.com/v1/models", {}, b"{}") is None
