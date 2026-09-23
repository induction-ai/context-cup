"""The Pydantic engine's turn against a fake Responses endpoint: real
Pydantic AI request building, no network."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx2
import pytest
from context_cup_protocol import Dirs, ProviderClient, ProviderInfo, Target, TurnInput
from context_cup_pydantic import HISTORY, PydanticContext, finish
from context_cup_pydantic.engine import SEEN
from pydantic_ai import Agent
from pydantic_ai_harness.compaction import ClearToolResults

TOOL = {
    "type": "function",
    "name": "get_balance",
    "description": "Balance",
    "parameters": {"type": "object", "properties": {}},
}
OPENING = [
    {"role": "assistant", "content": "Hi! How can I help?"},
    {"role": "user", "content": "What's my balance?"},
]
REASONING = {
    "type": "reasoning",
    "id": "rs_1",
    "summary": [],
    "encrypted_content": "enc==",
}


def body(output: list[dict[str, Any]], rid: str) -> dict[str, Any]:
    return {
        "id": rid,
        "object": "response",
        "created_at": 1790000000,
        "status": "completed",
        "model": "gpt-5.5-2026-04-23",
        "output": output,
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "store": False,
        "usage": {
            "input_tokens": 50,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens": 9,
            "output_tokens_details": {"reasoning_tokens": 4},
            "total_tokens": 59,
        },
    }


def call(call_id: str) -> dict[str, Any]:
    return {
        "type": "function_call",
        "id": f"fc_{call_id}",
        "call_id": call_id,
        "name": "get_balance",
        "arguments": "{}",
        "status": "completed",
    }


def done(text: str) -> dict[str, Any]:
    return {
        "type": "message",
        "id": "msg_1",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def ctx_for(
    tmp_path: Path,
    items: list[dict[str, Any]],
    replies: list[dict[str, Any]],
    sent: list[tuple[str, dict[str, Any]]],
    *,
    first: bool = True,
    state: Any = None,
) -> PydanticContext:
    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.append((str(request.url), json.loads(request.content)))
        return httpx2.Response(200, json=replies[len(sent) - 1])

    payload = {
        "model": "gpt-5.5",
        "instructions": "Be a bank agent.",
        "input": items,
        "tools": [TOOL],
        "store": False,
    }
    turn = TurnInput(
        trial_id="t",
        turn_id="001_aaaaaa",
        turn_index=1,
        first=first,
        provider=ProviderInfo(
            name="openai",
            api_key="cc-proxy",
            client=ProviderClient(
                base_url="http://proxy.test/t/t/openai/v1", api="responses"
            ),
        ),
        target=Target(model="gpt-5.5", reasoning_effort="low"),
        context_payload=payload,
        original_payload=payload,
        state=state,
        dirs=Dirs(turn=str(tmp_path), state=str(tmp_path)),
    )
    return PydanticContext(
        turn, {}, httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    )


def test_capabilities_get_the_target_through_the_proxy_and_the_raw_response(
    tmp_path: Path,
) -> None:
    reply = body([REASONING, call("c1")], "resp_1")
    sent: list[tuple[str, dict[str, Any]]] = []
    ctx = ctx_for(tmp_path, OPENING, [reply], sent)
    assert finish(ctx, []) == reply
    url, request = sent[0]
    assert url == "http://proxy.test/t/t/openai/v1/responses"
    assert request["model"] == "gpt-5.5" and request["reasoning"]["effort"] == "low"
    assert request["instructions"] == "Be a bank agent."
    assert [t["name"] for t in request["tools"]] == ["get_balance"]
    assert "Hi! How can I help?" in json.dumps(request["input"])
    assert (tmp_path / HISTORY).exists()
    assert json.loads((tmp_path / SEEN).read_text()) == {"seen": 2}
    assert ctx.state is None, "state stays the driver's"

    # Next turn: the tool result goes back as a deferred result.
    items = [
        *OPENING,
        REASONING,
        call("c1"),
        {"type": "function_call_output", "call_id": "c1", "output": "balance 12 USD"},
    ]
    second = body([done("You have 12 USD.")], "resp_2")
    sent2: list[tuple[str, dict[str, Any]]] = []
    ctx = ctx_for(tmp_path, items, [second], sent2, first=False, state=ctx.state)
    assert finish(ctx, []) == second
    outputs = [
        i for i in sent2[0][1]["input"] if i.get("type") == "function_call_output"
    ]
    assert outputs == [
        {"type": "function_call_output", "call_id": "c1", "output": "balance 12 USD"}
    ]


def test_an_agent_keeps_its_instructions_and_model_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # As in a trial container, where the runner sets the placeholder key.
    monkeypatch.setenv("OPENAI_API_KEY", "cc-proxy")
    sent: list[tuple[str, dict[str, Any]]] = []
    ctx = ctx_for(tmp_path, OPENING, [body([done("hi")], "r")], sent)
    agent = Agent("openai-responses:gpt-5.4", instructions="Speak like a pirate.")
    finish(ctx, agent)
    url, request = sent[0]
    assert url.startswith("http://proxy.test/"), "the connection is always the proxy"
    assert request["model"] == "gpt-5.4"
    assert "effort" not in (request.get("reasoning") or {}), (
        "the target's effort is not forced"
    )
    assert request["instructions"] == "Speak like a pirate."
    assert [t["name"] for t in request["tools"]] == ["get_balance"]


def test_an_agent_without_a_model_gets_the_target(tmp_path: Path) -> None:
    sent: list[tuple[str, dict[str, Any]]] = []
    ctx = ctx_for(tmp_path, OPENING, [body([done("hi")], "r")], sent)
    finish(ctx, Agent())
    assert sent[0][1]["model"] == "gpt-5.5"


def test_capabilities_are_applied(tmp_path: Path) -> None:
    replies = [
        body([call("c1")], "r1"),
        body([call("c2")], "r2"),
        body([done("ok")], "r3"),
    ]
    sent: list[tuple[str, dict[str, Any]]] = []
    strategy = [ClearToolResults(max_messages=1, keep_pairs=1)]
    ctx = ctx_for(tmp_path, OPENING, replies, sent)
    finish(ctx, strategy)
    items = [
        *OPENING,
        call("c1"),
        {"type": "function_call_output", "call_id": "c1", "output": "first " * 50},
    ]
    ctx = ctx_for(tmp_path, items, replies, sent, first=False, state=ctx.state)
    finish(ctx, strategy)
    items += [
        call("c2"),
        {"type": "function_call_output", "call_id": "c2", "output": "second"},
    ]
    ctx = ctx_for(tmp_path, items, replies, sent, first=False, state=ctx.state)
    finish(ctx, strategy)
    last = json.dumps(sent[-1][1]["input"])
    assert (
        "first first" not in last
        and "[tool result cleared]" in last
        and "second" in last
    )


def test_anything_else_is_a_type_error(tmp_path: Path) -> None:
    ctx = ctx_for(tmp_path, OPENING, [], [])
    try:
        finish(ctx, "capabilities")
    except TypeError as exc:
        assert "capabilities or an Agent" in str(exc)
    else:
        raise AssertionError("expected TypeError")
