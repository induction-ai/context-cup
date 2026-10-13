"""The AI SDK for Python engine against a mock transport: real SDK request
building for each provider, no network. The mock answers with the stream a
provider would send, since the SDK only streams."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import ai
import httpx2
import pytest
from ai.types.messages import TextPart, ToolCallPart, ToolResultPart

from context_cup_aisdk import AisdkContext, engine, finish
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

API = {"openai": "responses", "anthropic": "messages"}
VERSION = {"openai": "/v1", "anthropic": "/v1"}
MODEL = {"openai": "gpt-5.5", "anthropic": "claude-sonnet-4-6"}
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
}


def sse(*events: dict[str, Any]) -> bytes:
    return "".join(
        f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events
    ).encode()


def openai_stream(raw: dict[str, Any]) -> bytes:
    """The Responses stream behind a non-streaming body `raw`."""
    events: list[dict[str, Any]] = [
        {
            "type": "response.created",
            "response": {**raw, "status": "in_progress", "output": []},
        }
    ]
    for i, item in enumerate(raw["output"]):
        if item["type"] == "message":
            events.append(
                {
                    "type": "response.output_item.added",
                    "output_index": i,
                    "item": {**item, "content": []},
                }
            )
            for part in item["content"]:
                events.append(
                    {
                        "type": "response.output_text.delta",
                        "output_index": i,
                        "item_id": item["id"],
                        "delta": part["text"],
                    }
                )
        elif item["type"] == "function_call":
            events.append(
                {
                    "type": "response.output_item.added",
                    "output_index": i,
                    "item": {**item, "arguments": ""},
                }
            )
            events.append(
                {
                    "type": "response.function_call_arguments.delta",
                    "output_index": i,
                    "item_id": item["id"],
                    "delta": item["arguments"],
                }
            )
        else:
            events.append(
                {"type": "response.output_item.added", "output_index": i, "item": item}
            )
        events.append(
            {"type": "response.output_item.done", "output_index": i, "item": item}
        )
    events.append({"type": "response.completed", "response": raw})
    return sse(*events)


def anthropic_stream(raw: dict[str, Any]) -> bytes:
    """The Messages stream behind a non-streaming body `raw`."""
    events: list[dict[str, Any]] = [
        {
            "type": "message_start",
            "message": {
                **raw,
                "content": [],
                "stop_reason": None,
                "usage": {**raw["usage"], "output_tokens": 0},
            },
        }
    ]
    for i, block in enumerate(raw["content"]):
        if block["type"] == "text":
            events.append(
                {
                    "type": "content_block_start",
                    "index": i,
                    "content_block": {"type": "text", "text": ""},
                }
            )
            events.append(
                {
                    "type": "content_block_delta",
                    "index": i,
                    "delta": {"type": "text_delta", "text": block["text"]},
                }
            )
        elif block["type"] == "tool_use":
            events.append(
                {
                    "type": "content_block_start",
                    "index": i,
                    "content_block": {**block, "input": {}},
                }
            )
            events.append(
                {
                    "type": "content_block_delta",
                    "index": i,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": json.dumps(block["input"]),
                    },
                }
            )
        elif block["type"] == "thinking":
            events.append(
                {
                    "type": "content_block_start",
                    "index": i,
                    "content_block": {
                        "type": "thinking",
                        "thinking": "",
                        "signature": "",
                    },
                }
            )
            events.append(
                {
                    "type": "content_block_delta",
                    "index": i,
                    "delta": {"type": "thinking_delta", "thinking": block["thinking"]},
                }
            )
            events.append(
                {
                    "type": "content_block_delta",
                    "index": i,
                    "delta": {
                        "type": "signature_delta",
                        "signature": block["signature"],
                    },
                }
            )
        events.append({"type": "content_block_stop", "index": i})
    events.append(
        {
            "type": "message_delta",
            "delta": {"stop_reason": raw["stop_reason"], "stop_sequence": None},
            "usage": {"output_tokens": raw["usage"]["output_tokens"]},
        }
    )
    events.append({"type": "message_stop"})
    return sse(*events)


def stream_for(url: str) -> bytes:
    if "/responses" in url:
        return openai_stream(RAW["openai"])
    return anthropic_stream(RAW["anthropic"])


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[httpx2.Request]:
    requests: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return httpx2.Response(
            200,
            content=stream_for(str(request.url)),
            headers={"content-type": "text/event-stream"},
        )

    monkeypatch.setattr(engine, "TRANSPORT", httpx2.MockTransport(handler))
    return requests


def payload_after_a_tool_round(
    provider: Provider, effort: str | None = None
) -> dict[str, Any]:
    """The course's native payload after one tool call and its result."""
    adapter = adapter_for(provider)
    payload = adapter.initial_payload(
        model=MODEL[provider],
        system="Be brief.",
        opening=[Utterance("user", "What's my balance?")],
        tools=[TOOL],
        reasoning_effort=effort,
    )
    turn_one = {
        "openai": RAW["openai"],
        "anthropic": {
            **RAW["anthropic"],
            "content": [
                {"type": "thinking", "thinking": "Look it up.", "signature": "sig=="},
                {
                    "type": "tool_use",
                    "id": "call_9",
                    "name": "get_balance",
                    "input": {},
                },
            ],
            "stop_reason": "tool_use",
        },
    }[provider]
    adapter.append_response(payload, turn_one)
    call = adapter.extract(turn_one).tool_calls[0]
    adapter.append_tool_results(payload, [(ToolCallRef(call.id, call.name, {}), "42")])
    return payload


def context(
    provider: Provider,
    tmp_path: Path,
    effort: str | None = None,
    model: str | None = None,
) -> AisdkContext:
    payload = payload_after_a_tool_round(provider, effort)
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
        target=Target(model=model or MODEL[provider], reasoning_effort=effort),
        context_payload=payload,
        original_payload=payload,
        state=None,
        dirs=Dirs(turn=str(tmp_path / "turn"), state=str(tmp_path / "state")),
    )
    return AisdkContext(turn, {})


def shape(messages: list[ai.types.messages.Message]) -> list[tuple[str, list[Any]]]:
    """Messages without their random ids, for comparing."""
    return [(m.role, [p.model_dump(exclude={"id"}) for p in m.parts]) for m in messages]


def body_of(request: httpx2.Request) -> dict[str, Any]:
    parsed: dict[str, Any] = json.loads(request.content)
    return parsed


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_messages_come_from_each_providers_payload(
    provider: Provider, tmp_path: Path
) -> None:
    ctx = context(provider, tmp_path)
    messages = ctx.context_messages
    assert [m.role for m in messages] == ["system", "user", "assistant", "tool"]
    assert isinstance(messages[0].parts[0], TextPart)
    assert messages[0].parts[0].text == "Be brief."
    calls = [p for p in messages[2].parts if isinstance(p, ToolCallPart)]
    assert [c.tool_name for c in calls] == ["get_balance"]
    results = [p for p in messages[3].parts if isinstance(p, ToolResultPart)]
    assert [(r.tool_call_id, r.result) for r in results] == [
        (calls[0].tool_call_id, "42")
    ]
    assert [t.name for t in ctx.tools] == ["get_balance"]


@pytest.mark.parametrize(
    ("provider", "path"),
    [
        ("openai", "/t/trial-1/openai/v1/responses"),
        ("anthropic", "/t/trial-1/anthropic/v1/messages"),
    ],
)
def test_the_default_call_carries_the_engines_connection(
    provider: Provider, path: str, sent: list[httpx2.Request], tmp_path: Path
) -> None:
    ctx = context(provider, tmp_path)
    message = ctx.llm.generate()
    request = sent[-1]
    assert request.url.path == path
    assert request.headers["x-cc-purpose"] == "turn"
    key = request.headers.get("authorization") or request.headers.get("x-api-key")
    assert key is not None and "cc-proxy" in key
    body = body_of(request)
    assert "get_balance" in json.dumps(body.get("tools"))
    if provider == "openai":
        assert body["model"] == "gpt-5.5" and body["store"] is False
        assert body["include"] == ["reasoning.encrypted_content"]
        assert [i.get("type") for i in body["input"]][-3:] == [
            "reasoning",
            "function_call",
            "function_call_output",
        ]
        # The reasoning item goes back as it came, encrypted content and all.
        assert body["input"][-3] == RAW["openai"]["output"][0]
        assert finish(ctx, message) == RAW["openai"]
    else:
        assert body["model"] == "claude-sonnet-4-6" and body["system"] == "Be brief."
        assert body["max_tokens"] == ctx.context_payload["max_tokens"]
        blocks = body["messages"][-2]["content"]
        assert blocks[0] == {
            "type": "thinking",
            "thinking": "Look it up.",
            "signature": "sig==",
        }
        assert blocks[1]["type"] == "tool_use"
        raw = finish(ctx, message)
        assert raw["content"] == RAW["anthropic"]["content"]
        assert raw["stop_reason"] == "end_turn" and raw["id"] == "msg_raw"
    assert message.role == "assistant"


def test_reasoning_settings_come_from_the_target(
    sent: list[httpx2.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path, effort="low")
    ctx.llm.generate()
    assert body_of(sent[-1])["reasoning"]["effort"] == "low"

    ctx = context("anthropic", tmp_path, effort="medium")
    ctx.llm.generate()
    body = body_of(sent[-1])
    assert body["thinking"] == ctx.context_payload["thinking"]
    assert body["max_tokens"] == ctx.context_payload["max_tokens"]


def test_overrides_win_and_another_provider_still_goes_through_the_proxy(
    sent: list[httpx2.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path)
    ctx.llm.generate(
        [ai.user_message("Summarise.")],
        model="anthropic/claude-sonnet-4-6",
        tools=[],
        purpose="summarize",
    )
    request = sent[-1]
    body = body_of(request)
    assert request.url.path == "/t/trial-1/anthropic/v1/messages"
    assert request.headers["x-cc-purpose"] == "summarize"
    assert body["model"] == "claude-sonnet-4-6" and "tools" not in body
    assert body["messages"][-1]["content"] in (
        "Summarise.",
        [{"type": "text", "text": "Summarise."}],
    )


def test_the_returned_calls_raw_body_is_the_turns_response(
    sent: list[httpx2.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path)
    ctx.llm.generate(model="anthropic/claude-sonnet-4-6", purpose="summarize")
    turn = ctx.llm.generate()
    assert finish(ctx, turn)["id"] == "resp_raw"


def test_a_message_not_from_ctx_llm_or_from_another_provider_is_rejected(
    sent: list[httpx2.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path)
    with pytest.raises(TypeError, match=r"ctx\.llm\.generate"):
        finish(ctx, ai.assistant_message("made up"))
    aside = ctx.llm.generate(model="anthropic/claude-sonnet-4-6")
    with pytest.raises(TypeError, match="run's provider"):
        finish(ctx, aside)


def test_base_aisdk_python_runs_a_turn_end_to_end(
    sent: list[httpx2.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path)
    turn_file = tmp_path / "input.json"
    turn_file.write_text(ctx.turn.model_dump_json())
    out = tmp_path / "output.json"
    driver = Path(__file__).resolve().parents[3] / "drivers" / "base_aisdk_python"
    argv = ["--driver", str(driver), "--input", str(turn_file), "--output", str(out)]
    assert run_engine(AisdkContext, "aisdk_python", argv, finish=finish) == 0
    written = json.loads(out.read_text())
    assert written["response"] == RAW["openai"]
    assert written["driver"] == {
        "name": "base_aisdk_python",
        "engine": "aisdk_python",
        "version": "0.1.0",
    }


def test_context_messages_keep_the_drivers_edits_and_gain_only_what_is_new(
    sent: list[httpx2.Request], tmp_path: Path
) -> None:
    ctx = context("openai", tmp_path)
    assert shape(ctx.original_messages) == shape(ctx.context_messages)
    # The driver drops the user's question, keeping the system text and the
    # tool round.
    ctx.context_messages = [ctx.context_messages[0], *ctx.context_messages[-2:]]
    finish(ctx, ctx.llm.generate())

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
    later = AisdkContext(turn, {})
    assert later.context_messages[:3] == ctx.context_messages
    last = later.context_messages[-1]
    assert last.role == "assistant" and shape([last]) == shape(
        [ai.assistant_message("Done.")]
    )
    assert len(later.original_messages) > len(later.context_messages)

    # An attempt the runner throws away leaves nothing for its retry: the
    # retry starts again from the last accepted turn.
    later.context_messages = []
    finish(later, later.llm.generate())
    retry = AisdkContext(turn.model_copy(update={"turn_id": "004_mnopqr"}), {})
    assert retry.context_messages[:3] == ctx.context_messages
