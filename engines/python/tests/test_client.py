import json

import httpx
import pytest
from conftest import OPENAI
from context_cup_engine.client import ProviderError, call, request_for
from context_cup_engine.protocol import ProviderClient, ProviderInfo

ANTHROPIC = ProviderInfo(
    name="anthropic",
    api_key="ak-test",
    client=ProviderClient(base_url="https://api.anthropic.com/v1", api="messages"),
)
GEMINI = ProviderInfo(
    name="gemini",
    api_key="gk-test",
    client=ProviderClient(
        base_url="https://generativelanguage.googleapis.com/v1beta",
        api="generate_content",
    ),
)


def test_request_shapes_per_api():
    url, headers, body = request_for(OPENAI, {"model": "gpt-5.5", "input": []})
    assert url == "http://proxy.test:1/t/trial-1/openai/v1/responses"
    assert headers["authorization"] == "Bearer cc-proxy" and body["model"] == "gpt-5.5"

    url, headers, body = request_for(ANTHROPIC, {"model": "claude", "messages": []})
    assert url == "https://api.anthropic.com/v1/messages"
    assert headers["x-api-key"] == "ak-test" and "anthropic-version" in headers

    url, headers, body = request_for(
        GEMINI, {"model": "gemini-3.1-pro", "contents": []}
    )
    assert url.endswith("/models/gemini-3.1-pro:generateContent")
    assert headers["x-goog-api-key"] == "gk-test"
    assert "model" not in body and body["contents"] == []


def test_call_returns_the_response_object_and_retries_on_429():
    attempts = []
    purposes = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(json.loads(request.content))
        purposes.append(request.headers.get("x-cc-purpose"))
        if len(attempts) == 1:
            return httpx.Response(
                429, headers={"retry-after": "0"}, json={"error": "slow down"}
            )
        return httpx.Response(200, json={"id": "resp_1", "output": [], "usage": {}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        response = call(
            OPENAI,
            {"model": "gpt-5.5", "input": []},
            client=http,
            sleep=lambda _s: None,
        )
    assert response["id"] == "resp_1" and len(attempts) == 2
    assert purposes == ["turn", "turn"]


def test_call_raises_provider_error_on_4xx():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"message": "bad"}})

    with (
        httpx.Client(transport=httpx.MockTransport(handler)) as http,
        pytest.raises(ProviderError) as err,
    ):
        call(
            OPENAI,
            {"model": "gpt-5.5", "input": []},
            client=http,
            sleep=lambda _s: None,
        )
    assert err.value.status == 400 and err.value.provider == "openai"
