"""The LiteLLM engine against a mock transport: real litellm request
building for each provider, no network."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from context_cup_litellm import LitellmContext, engine, finish
from context_cup_protocol import (
    Dirs,
    Provider,
    ProviderClient,
    ProviderInfo,
    Target,
    ToolCallRef,
    TurnInput,
    Utterance,
    adapter_for,
    run_engine,
)

API = {"openai": "responses", "anthropic": "messages", "gemini": "generate_content"}
VERSION = {"openai": "/v1", "anthropic": "/v1", "gemini": "/v1beta"}
MODEL = {
    "openai": "gpt-5.5",
    "anthropic": "claude-sonnet-4-6",
    "gemini": "gemini-3.1-pro-preview",
}
ROOT = "http://proxy.test/t/trial-1"
TOOL = {
    "type": "function",
    "function": {
        "name": "get_balance",
        "description": "Balance",
        "parameters": {"type": "object", "properties": {}},
    },
}
RAW: dict[str, dict[str, Any]] = {
    "openai": {
        "id": "resp_raw",
        "object": "response",
        "created_at": 1790000000,
        "status": "completed",
        "model": "gpt-5.5-2026-04-23",
        "output": [
            {
                "type": "reasoning",
                "id": "rs_1",
                "summary": [],
                "encrypted_content": "e==",
            },
            {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_9",
                "name": "get_balance",
                "arguments": "{}",
                "status": "completed",
            },
        ],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "usage": {
            "input_tokens": 50,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens": 9,
            "output_tokens_details": {"reasoning_tokens": 4},
            "total_tokens": 59,
        },
    },
    "anthropic": {
        "id": "msg_raw",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-4-6",
        "content": [{"type": "text", "text": "Your balance is 42."}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 20, "output_tokens": 5},
    },
    "gemini": {
        "candidates": [
            {
                "content": {"role": "model", "parts": [{"text": "It is 42."}]},
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 12,
            "candidatesTokenCount": 3,
            "totalTokenCount": 15,
        },
        "modelVersion": "gemini-3.1-pro-preview",
        "responseId": "gem_raw",
    },
}


def raw_for(url: str) -> dict[str, Any]:
    if "/responses" in url:
        return RAW["openai"]
    if "/messages" in url:
        return RAW["anthropic"]
    return RAW["gemini"]


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=raw_for(str(request.url)))

    monkeypatch.setattr(engine, "TRANSPORT", httpx.MockTransport(handler))
    return requests


def payload_after_a_tool_round(provider: Provider) -> dict[str, Any]:
    """The course's native payload after one tool call and its result."""
    adapter = adapter_for(provider)
    payload = adapter.initial_payload(
        model=MODEL[provider],
        system="Be brief.",
        opening=[Utterance("user", "What's my balance?")],
        tools=[TOOL],
        reasoning_effort=None,
    )
    turn_one = {
        "openai": RAW["openai"],
        "anthropic": {
            **RAW["anthropic"],
            "content": [
                {"type": "tool_use", "id": "call_9", "name": "get_balance", "input": {}}
            ],
            "stop_reason": "tool_use",
        },
        "gemini": {
            **RAW["gemini"],
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [
                            {
                                "functionCall": {"name": "get_balance", "args": {}},
                                "thoughtSignature": "real-signature==",
                            }
                        ],
                    },
                    "index": 0,
                }
            ],
        },
    }[provider]
    adapter.append_response(payload, turn_one)
    call = adapter.extract(turn_one).tool_calls[0]
    adapter.append_tool_results(payload, [(ToolCallRef(call.id, call.name, {}), "42")])
    return payload


def context(
    provider: Provider, tmp_path: Path, effort: str | None = None
) -> LitellmContext:
    payload = payload_after_a_tool_round(provider)
    turn = TurnInput(
        trial_id="trial-1",
        turn_id="002_abcdef",
        turn_index=2,
        first=False,
        provider=ProviderInfo(
            name=provider,
            api_key="cc-proxy",
            client=ProviderClient(
                base_url=f"{ROOT}/{provider}{VERSION[provider]}", api=API[provider]
            ),
        ),
        target=Target(model=MODEL[provider], reasoning_effort=effort),
        context_payload=payload,
        original_payload=payload,
        state=None,
        dirs=Dirs(turn=str(tmp_path / "turn"), state=str(tmp_path / "state")),
    )
    return LitellmContext(turn, {})


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini"])
def test_messages_come_from_each_providers_payload(
    provider: Provider, tmp_path: Path
) -> None:
    ctx = context(provider, tmp_path)
    roles = [m["role"] for m in ctx.context_messages]
    assert roles[0] == "system" and ctx.context_messages[0]["content"] == "Be brief."
    assert roles[-3:] == ["user", "assistant", "tool"]
    assert (
        ctx.context_messages[-2]["tool_calls"][0]["function"]["name"] == "get_balance"
    )
    assert ctx.context_messages[-1]["content"] == "42"
    assert (
        ctx.context_messages[-1]["tool_call_id"]
        == ctx.context_messages[-2]["tool_calls"][0]["id"]
    )
    assert [t["function"]["name"] for t in ctx.tools] == ["get_balance"]


@pytest.mark.parametrize(
    ("provider", "path"),
    [
        ("openai", "/t/trial-1/openai/v1/responses"),
        ("anthropic", "/t/trial-1/anthropic/v1/messages"),
        (
            "gemini",
            "/t/trial-1/gemini/v1beta/models/gemini-3.1-pro-preview:generateContent",
        ),
    ],
)
def test_the_default_call_carries_the_engines_connection(
    provider: Provider, path: str, sent: list[httpx.Request], tmp_path: Path
) -> None:
    ctx = context(provider, tmp_path)
    response = ctx.llm.completion()
    request = sent[-1]
    assert request.url.path == path
    assert request.headers["x-cc-purpose"] == "turn"
    key = (
        request.headers.get("authorization")
        or request.headers.get("x-api-key")
        or request.headers.get("x-goog-api-key")
    )
    assert key is not None and "cc-proxy" in key
    body = json.loads(request.content)
    assert "get_balance" in json.dumps(body.get("tools"))
    if provider == "openai":
        assert body["model"] == "gpt-5.5" and body["store"] is False
        assert [i.get("type") for i in body["input"]][-2:] == [
            "function_call",
            "function_call_output",
        ]
    assert finish(ctx, response) == RAW[provider]


def test_reasoning_effort_comes_from_the_target(
    sent: list[httpx.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path, effort="low")
    ctx.llm.completion()
    assert json.loads(sent[-1].content)["reasoning"]["effort"] == "low"


def test_overrides_win_and_another_provider_still_goes_through_the_proxy(
    sent: list[httpx.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path)
    ctx.llm.completion(
        messages=[{"role": "user", "content": "Summarise."}],
        model="anthropic/claude-sonnet-4-6",
        tools=None,
        purpose="summarize",
    )
    request = sent[-1]
    body = json.loads(request.content)
    assert request.url.path == "/t/trial-1/anthropic/v1/messages"
    assert request.headers["x-cc-purpose"] == "summarize"
    assert body["model"] == "claude-sonnet-4-6" and "tools" not in body
    assert body["messages"][-1]["content"] in (
        "Summarise.",
        [{"type": "text", "text": "Summarise."}],
    )


def test_the_returned_calls_raw_body_is_the_turns_response(
    sent: list[httpx.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path)
    ctx.llm.completion(model="anthropic/claude-sonnet-4-6", purpose="summarize")
    turn = ctx.llm.completion()
    assert finish(ctx, turn)["id"] == "resp_raw"


def test_a_response_not_from_ctx_llm_or_from_another_provider_is_rejected(
    sent: list[httpx.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path)
    with pytest.raises(TypeError, match=r"ctx\.llm\.completion"):
        finish(ctx, {"id": "resp_x"})
    aside = ctx.llm.completion(model="anthropic/claude-sonnet-4-6")
    with pytest.raises(TypeError, match="run's provider"):
        finish(ctx, aside)


def test_base_litellm_runs_a_turn_end_to_end(
    sent: list[httpx.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path)
    turn_file = tmp_path / "input.json"
    turn_file.write_text(ctx.turn.model_dump_json())
    out = tmp_path / "output.json"
    driver = Path(__file__).resolve().parents[3] / "drivers" / "base_litellm"
    argv = ["--driver", str(driver), "--input", str(turn_file), "--output", str(out)]
    assert run_engine(LitellmContext, "litellm", argv, finish=finish) == 0
    written = json.loads(out.read_text())
    assert written["response"] == RAW["openai"]
    assert written["driver"] == {
        "name": "base_litellm",
        "engine": "litellm",
        "version": "0.1.0",
    }


def test_gemini_thought_signatures_go_back_on_their_function_calls(
    sent: list[httpx.Request], tmp_path: Path
) -> None:
    ctx = context("gemini", tmp_path)
    call = ctx.context_messages[-2]["tool_calls"][0]
    assert call["provider_specific_fields"] == {"thought_signature": "real-signature=="}
    ctx.llm.completion()
    parts = [p for c in json.loads(sent[-1].content)["contents"] for p in c["parts"]]
    signed = [p for p in parts if "function_call" in p or "functionCall" in p]
    assert [p.get("thoughtSignature") for p in signed] == ["real-signature=="]


def test_context_messages_keep_the_drivers_edits_and_gain_only_what_is_new(
    sent: list[httpx.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path)
    assert ctx.original_messages == ctx.context_messages
    # The driver drops the user's question, keeping the system text and the
    # tool round.
    ctx.context_messages = [ctx.context_messages[0], *ctx.context_messages[-2:]]
    finish(ctx, ctx.llm.completion())

    # Next turn: the course appended the model's reply to the payload.
    payload = copy.deepcopy(ctx.turn.context_payload)
    payload["input"].append(
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Done."}],
        }
    )
    turn = ctx.turn.model_copy(
        update={
            "turn_id": "003_ghijkl",
            "turn_index": 3,
            "context_payload": payload,
            "original_payload": payload,
        }
    )
    later = LitellmContext(turn, {})
    assert later.context_messages[:3] == ctx.context_messages
    assert later.context_messages[-1] == {"role": "assistant", "content": "Done."}
    assert len(later.original_messages) > len(later.context_messages)

    # An attempt the runner throws away leaves nothing for its retry: the
    # retry starts again from the last accepted turn.
    later.context_messages = []
    finish(later, later.llm.completion())
    retry = LitellmContext(turn.model_copy(update={"turn_id": "004_mnopqr"}), {})
    assert retry.context_messages[:3] == ctx.context_messages
