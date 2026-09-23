"""Each provider adapter against response fixtures shaped like the real
APIs: reasoning items, thinking and tool_use blocks, functionCall parts with
thought signatures, all preserved verbatim on append."""

from __future__ import annotations

import copy
import json

import pytest
from context_cup_protocol.providers import ToolCallRef, Utterance, adapter_for
from context_cup_protocol.providers.base import function_schemas, parse_arguments

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_balance",
            "description": "Balance",
            "parameters": {
                "type": "object",
                "properties": {"acct": {"type": "string"}},
            },
        },
    }
]
OPENING = [Utterance("assistant", "Hi!"), Utterance("user", "What's my balance?")]


def build(provider: str, effort: str | None = "medium"):
    adapter = adapter_for(provider)
    payload = adapter.initial_payload(
        model="m1",
        system="be helpful",
        opening=OPENING,
        tools=TOOLS,
        reasoning_effort=effort,
    )
    return adapter, payload


def test_function_schema_and_argument_helpers():
    schemas = function_schemas(TOOLS)
    assert (
        schemas[0].name == "get_balance"
        and "acct" in schemas[0].parameters["properties"]
    )
    with pytest.raises(ValueError, match="without a name"):
        function_schemas([{"type": "function", "function": {}}])
    assert parse_arguments('{"a": 1}') == {"a": 1}
    assert parse_arguments(None) == {}
    assert parse_arguments("not json") == {"_raw": "not json"}
    assert parse_arguments("[1]") == {"_raw": "[1]"}


# --- OpenAI ------------------------------------------------------------------

OPENAI_RESPONSE = {
    "id": "resp_1",
    "object": "response",
    "model": "m1-2026-01-01",
    "output": [
        {"type": "reasoning", "id": "rs_1", "encrypted_content": "enc", "summary": []},
        {
            "type": "message",
            "id": "msg_1",
            "role": "assistant",
            "content": [
                {"type": "output_text", "text": "Checking.", "annotations": []}
            ],
        },
        {
            "type": "function_call",
            "id": "fc_1",
            "call_id": "call_1",
            "name": "get_balance",
            "arguments": '{"acct": "42"}',
        },
    ],
    "usage": {"input_tokens": 10, "output_tokens": 5},
}


def test_openai_round_trip():
    adapter, payload = build("openai")
    assert payload["instructions"] == "be helpful"
    assert payload["reasoning"] == {"effort": "medium"}
    assert payload["store"] is False and payload["include"] == [
        "reasoning.encrypted_content"
    ]
    assert payload["tools"] == [
        {
            "type": "function",
            "name": "get_balance",
            "description": "Balance",
            "parameters": TOOLS[0]["function"]["parameters"],
        }
    ]
    assert payload["input"] == [
        {"role": "assistant", "content": "Hi!"},
        {"role": "user", "content": "What's my balance?"},
    ]

    extracted = adapter.extract(OPENAI_RESPONSE)
    assert extracted.text == "Checking."
    assert extracted.tool_calls == [
        ToolCallRef("call_1", "get_balance", {"acct": "42"})
    ]
    assert not extracted.empty

    adapter.append_response(payload, OPENAI_RESPONSE)
    assert payload["input"][2:] == OPENAI_RESPONSE["output"]
    adapter.append_tool_results(payload, [(extracted.tool_calls[0], "$10")])
    assert payload["input"][-1] == {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": "$10",
    }
    adapter.append_user(payload, "thanks")
    assert payload["input"][-1] == {"role": "user", "content": "thanks"}
    json.dumps(payload)

    steps = adapter.steps_from_payload(payload)
    assert [(s.source, s.message) for s in steps] == [
        ("system", "be helpful"),
        ("agent", "Hi!"),
        ("user", "What's my balance?"),
        ("agent", "Checking."),
        ("user", "thanks"),
    ]
    assert steps[3].tool_calls[0].name == "get_balance"
    assert steps[3].results == [("call_1", "$10")]


def test_openai_empty_and_no_effort():
    adapter, payload = build("openai", effort="none")
    assert "reasoning" not in payload
    assert adapter.extract({"output": [{"type": "reasoning", "id": "r"}]}).empty
    assert adapter.extract({"output": []}).empty


# --- Anthropic ---------------------------------------------------------------

ANTHROPIC_RESPONSE = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "m1",
    "content": [
        {"type": "thinking", "thinking": "hmm", "signature": "sig=="},
        {"type": "text", "text": "Checking."},
        {
            "type": "tool_use",
            "id": "toolu_1",
            "name": "get_balance",
            "input": {"acct": "42"},
        },
    ],
    "stop_reason": "tool_use",
    "usage": {"input_tokens": 10, "output_tokens": 5},
}


def test_anthropic_round_trip():
    adapter, payload = build("anthropic")
    assert payload["system"] == "be helpful"
    assert payload["thinking"] == {"type": "enabled", "budget_tokens": 8192}
    assert payload["max_tokens"] > 8192
    assert payload["tools"] == [
        {
            "name": "get_balance",
            "description": "Balance",
            "input_schema": TOOLS[0]["function"]["parameters"],
        }
    ]
    # An assistant-first opening gets a user placeholder, as the API demands.
    roles = [m["role"] for m in payload["messages"]]
    assert roles == ["user", "assistant", "user"]
    assert payload["messages"][1]["content"] == [{"type": "text", "text": "Hi!"}]

    extracted = adapter.extract(ANTHROPIC_RESPONSE)
    assert extracted.text == "Checking."
    assert extracted.tool_calls == [
        ToolCallRef("toolu_1", "get_balance", {"acct": "42"})
    ]

    adapter.append_response(payload, ANTHROPIC_RESPONSE)
    assert payload["messages"][-1] == {
        "role": "assistant",
        "content": ANTHROPIC_RESPONSE["content"],
    }
    adapter.append_tool_results(payload, [(extracted.tool_calls[0], "$10")])
    assert payload["messages"][-1] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "$10"}
        ],
    }
    adapter.append_tool_results(payload, [])
    assert payload["messages"][-1]["content"][0]["type"] == "tool_result"
    adapter.append_user(payload, "thanks")
    json.dumps(payload)

    steps = adapter.steps_from_payload(payload)
    assert [(s.source, s.message) for s in steps] == [
        ("system", "be helpful"),
        ("agent", "Hi!"),
        ("user", "What's my balance?"),
        ("agent", "Checking."),
        ("user", "thanks"),
    ]
    assert steps[3].results == [("toolu_1", "$10")]


def test_anthropic_no_thinking_when_effort_absent():
    _, payload = build("anthropic", effort=None)
    assert "thinking" not in payload and payload["max_tokens"] == 16384


# --- Gemini ------------------------------------------------------------------

GEMINI_RESPONSE = {
    "candidates": [
        {
            "content": {
                "role": "model",
                "parts": [
                    {"text": "thinking...", "thought": True},
                    {"text": "Checking."},
                    {
                        "functionCall": {"name": "get_balance", "args": {"acct": "42"}},
                        "thoughtSignature": "sig==",
                    },
                ],
            },
            "finishReason": "STOP",
        }
    ],
    "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5},
    "responseId": "r1",
}


def test_gemini_round_trip_mints_ids_when_the_api_has_none():
    adapter, payload = build("gemini")
    assert payload["systemInstruction"] == {"parts": [{"text": "be helpful"}]}
    assert payload["generationConfig"] == {"thinkingConfig": {"thinkingBudget": 8192}}
    assert payload["tools"][0]["functionDeclarations"][0]["name"] == "get_balance"
    assert [c["role"] for c in payload["contents"]] == ["user", "model", "user"]

    extracted = adapter.extract(GEMINI_RESPONSE)
    assert extracted.text == "Checking."
    call = extracted.tool_calls[0]
    assert call.name == "get_balance" and call.arguments == {"acct": "42"}
    assert call.id.startswith("gemini-call-")

    adapter.append_response(payload, GEMINI_RESPONSE)
    assert payload["contents"][-1] == GEMINI_RESPONSE["candidates"][0]["content"]
    assert payload["contents"][-1]["parts"][2]["thoughtSignature"] == "sig=="
    adapter.append_tool_results(payload, [(call, "$10")])
    assert payload["contents"][-1] == {
        "role": "user",
        "parts": [
            {"functionResponse": {"name": "get_balance", "response": {"result": "$10"}}}
        ],
    }
    json.dumps(payload)
    steps = adapter.steps_from_payload(payload)
    assert [s.source for s in steps] == ["system", "agent", "user", "agent"]
    assert (
        steps[3].message == "Checking." and steps[3].tool_calls[0].name == "get_balance"
    )
    assert steps[3].results[0][1] == "$10"
    assert steps[3].results[0][0] == steps[3].tool_calls[0].id


def test_gemini_keeps_api_call_ids():
    adapter, payload = build("gemini", effort=None)
    assert "generationConfig" not in payload
    response = copy.deepcopy(GEMINI_RESPONSE)
    response["candidates"][0]["content"]["parts"][2]["functionCall"]["id"] = "fc-9"
    call = adapter.extract(response).tool_calls[0]
    assert call.id == "fc-9"
    adapter.append_tool_results(payload, [(call, "x")])
    assert payload["contents"][-1]["parts"][0]["functionResponse"]["id"] == "fc-9"
    assert adapter.extract(
        {"candidates": [{"content": {"parts": [{"text": "  "}]}}]}
    ).empty


def test_unknown_provider():
    with pytest.raises(ValueError, match="unknown provider"):
        adapter_for("cohere")
