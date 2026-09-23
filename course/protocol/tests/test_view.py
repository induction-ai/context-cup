"""The provider-neutral view: unedited payloads round-trip byte for byte, and
an edit changes only what it names."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest
from context_cup_protocol import Message, ToolCall, view, write

OPENAI: dict[str, Any] = {
    "model": "gpt-5.5",
    "instructions": "You are a bank agent.",
    "input": [
        {"role": "assistant", "content": "Hi! How can I help?"},
        {"role": "user", "content": "What's my balance?"},
        {
            "type": "reasoning",
            "id": "rs_1",
            "summary": [],
            "encrypted_content": "enc==",
        },
        {
            "type": "function_call",
            "id": "fc_1",
            "call_id": "call_1",
            "name": "get_balance",
            "arguments": '{"acct":"A-1"}',
            "status": "completed",
        },
        {
            "type": "function_call",
            "id": "fc_2",
            "call_id": "call_2",
            "name": "get_limits",
            "arguments": "{}",
            "status": "completed",
        },
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "balance 12 USD",
        },
        {"type": "function_call_output", "call_id": "call_2", "output": "x" * 40},
        {
            "type": "reasoning",
            "id": "rs_2",
            "summary": [],
            "encrypted_content": "enc2==",
        },
        {
            "type": "message",
            "id": "msg_1",
            "role": "assistant",
            "status": "completed",
            "content": [
                {"type": "output_text", "text": "You have 12 USD.", "annotations": []}
            ],
        },
        {"role": "user", "content": [{"type": "input_text", "text": "Thanks"}]},
    ],
    "tools": [
        {
            "type": "function",
            "name": "get_balance",
            "description": "Balance",
            "parameters": {
                "type": "object",
                "properties": {"acct": {"type": "string"}},
            },
        },
        {"type": "web_search"},
    ],
    "reasoning": {"effort": "medium"},
    "store": False,
    "include": ["reasoning.encrypted_content"],
}

ANTHROPIC: dict[str, Any] = {
    "model": "claude-sonnet-4-6",
    "max_tokens": 16384,
    "system": [
        {
            "type": "text",
            "text": "You are a bank agent.",
            "cache_control": {"type": "ephemeral"},
        }
    ],
    "messages": [
        {
            "role": "user",
            "content": [{"type": "text", "text": "(Start of conversation)"}],
        },
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "Hi! How can I help?"}],
        },
        {"role": "user", "content": "What's my balance?"},
        {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "look it up", "signature": "sig=="},
                {"type": "text", "text": "Checking."},
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "get_balance",
                    "input": {"acct": "A-1"},
                },
                {
                    "type": "tool_use",
                    "id": "toolu_2",
                    "name": "get_limits",
                    "input": {},
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "balance 12 USD",
                    "cache_control": {"type": "ephemeral"},
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_2",
                    "content": [{"type": "text", "text": "x" * 40}],
                },
            ],
        },
    ],
    "tools": [
        {
            "name": "get_balance",
            "description": "Balance",
            "input_schema": {
                "type": "object",
                "properties": {"acct": {"type": "string"}},
            },
        },
        {"type": "web_search_20250305", "name": "web_search"},
    ],
    "thinking": {"type": "enabled", "budget_tokens": 8192},
}

GEMINI: dict[str, Any] = {
    "model": "gemini-3.1-pro",
    "systemInstruction": {"parts": [{"text": "You are a bank agent."}]},
    "contents": [
        {"role": "user", "parts": [{"text": "(Start of conversation)"}]},
        {"role": "model", "parts": [{"text": "Hi! How can I help?"}]},
        {"role": "user", "parts": [{"text": "What's my balance?"}]},
        {
            "role": "model",
            "parts": [
                {"text": "planning", "thought": True},
                {
                    "functionCall": {"name": "get_balance", "args": {"acct": "A-1"}},
                    "thoughtSignature": "sig==",
                },
                {"functionCall": {"name": "get_limits", "args": {}}},
            ],
        },
        {
            "role": "user",
            "parts": [
                {
                    "functionResponse": {
                        "name": "get_balance",
                        "response": {"result": "balance 12 USD"},
                    }
                },
                {
                    "functionResponse": {
                        "name": "get_limits",
                        "response": {"result": "x" * 40},
                    }
                },
            ],
        },
    ],
    "tools": [
        {
            "functionDeclarations": [
                {
                    "name": "get_balance",
                    "description": "Balance",
                    "parameters": {"type": "object", "properties": {}},
                }
            ]
        },
        {"googleSearch": {}},
    ],
    "generationConfig": {"thinkingConfig": {"thinkingBudget": 8192}},
}

FIXTURES = {"openai": OPENAI, "anthropic": ANTHROPIC, "gemini": GEMINI}


def dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


@pytest.mark.parametrize("provider", FIXTURES)
def test_unedited_view_round_trips_byte_for_byte(provider: str) -> None:
    payload = FIXTURES[provider]
    before = dumps(payload)
    conversation = view(provider, payload)  # type: ignore[arg-type]
    assert dumps(write(provider, payload, conversation)) == before  # type: ignore[arg-type]
    assert dumps(payload) == before, "view and write never touch their input"


@pytest.mark.parametrize("provider", FIXTURES)
def test_view_reads_the_conversation(provider: str) -> None:
    conversation = view(provider, FIXTURES[provider])  # type: ignore[arg-type]
    assert conversation.system == "You are a bank agent."
    assert [t.name for t in conversation.tools] == ["get_balance"]
    roles = [m.role for m in conversation.messages]
    assert "tool" in roles and roles.count("tool") == 2
    calls = [c for m in conversation.messages for c in m.tool_calls]
    assert [c.name for c in calls][:2] == ["get_balance", "get_limits"]
    assert calls[0].arguments == {"acct": "A-1"}
    tools = [m for m in conversation.messages if m.role == "tool"]
    assert tools[0].text == "balance 12 USD" and tools[1].text == "x" * 40
    # Each tool result answers a call the view exposes.
    assert {m.tool_call_id for m in tools} == {c.id for c in calls[:2]}
    # Provider-only material is carried, not dropped.
    assert any(m.opaque for m in conversation.messages if m.role == "assistant")


@pytest.mark.parametrize("provider", FIXTURES)
def test_editing_one_tool_result_changes_only_that_text(provider: str) -> None:
    payload = FIXTURES[provider]
    conversation = view(provider, payload)  # type: ignore[arg-type]
    tool = [m for m in conversation.messages if m.role == "tool"][1]
    tool.text = "clipped"
    out = write(provider, payload, conversation)  # type: ignore[arg-type]
    before, after = dumps(payload), dumps(out)
    assert after.count("x" * 40) == 0 and after.count("clipped") == 1
    assert after.replace("clipped", "x" * 40) == before, (
        "nothing but the edited text may change"
    )


def test_openai_edit_keeps_reasoning_and_ids_around_it() -> None:
    conversation = view("openai", OPENAI)
    assistant = [m for m in conversation.messages if m.role == "assistant"][-1]
    assistant.text = "You have 12 US dollars."
    out = write("openai", OPENAI, conversation)
    items = out["input"]
    message = next(i for i in items if i.get("id") == "msg_1")
    assert message["content"][0]["text"] == "You have 12 US dollars."
    assert any(i.get("id") == "rs_2" for i in items), "reasoning stays in place"
    assert out["tools"][1] == {"type": "web_search"}


def test_dropping_opaque_and_adding_messages() -> None:
    conversation = view("anthropic", ANTHROPIC)
    for message in conversation.messages:
        message.opaque = [o for o in message.opaque if o.get("type") != "thinking"]
    conversation.messages.append(Message(role="user", text="One more thing."))
    out = write("anthropic", ANTHROPIC, conversation)
    dumped = dumps(out)
    assert "thinking" not in json.dumps(out["messages"]) and "sig==" not in dumped
    assert out["messages"][-1] == {
        "role": "user",
        "content": [{"type": "text", "text": "One more thing."}],
    }
    # The system block keeps its cache_control; only messages changed.
    assert out["system"] == ANTHROPIC["system"]


def test_new_gemini_tool_result_goes_back_by_name() -> None:
    payload = copy.deepcopy(GEMINI)
    payload["contents"] = payload["contents"][:4]  # the model asked, nothing answered
    conversation = view("gemini", payload)
    calls = conversation.messages[-1].tool_calls
    conversation.messages.append(
        Message(role="tool", tool_call_id=calls[0].id, text="balance 12 USD")
    )
    out = write("gemini", payload, conversation)
    part = out["contents"][-1]["parts"][0]["functionResponse"]
    assert part == {"name": "get_balance", "response": {"result": "balance 12 USD"}}
    # The model turn is untouched: thought signature included.
    assert out["contents"][3] == payload["contents"][3]


def test_system_tools_and_calls_edit() -> None:
    conversation = view("openai", OPENAI)
    conversation.system = "Be terse."
    conversation.tools[0].description = "Account balance"
    conversation.messages[2].tool_calls[0] = ToolCall(
        id="call_1", name="get_balance", arguments={"acct": "B-2"}
    )
    out = write("openai", OPENAI, conversation)
    assert out["instructions"] == "Be terse."
    assert out["tools"][0]["description"] == "Account balance"
    assert out["tools"][1] == {"type": "web_search"}
    call = next(
        i
        for i in out["input"]
        if i.get("call_id") == "call_1" and i.get("type") == "function_call"
    )
    assert json.loads(call["arguments"]) == {"acct": "B-2"} and call["id"] == "fc_1"
