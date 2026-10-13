"""The cache-bust tool: one name per trial, valid for every provider, in the
shape the adapters take."""

from __future__ import annotations

import re

import pytest

from context_cup_protocol import (
    CACHE_BUST_TOOL_PREFIX,
    adapter_for,
    cache_bust_tool,
    cache_bust_tool_name,
    function_schemas,
)

NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")
"""The intersection of OpenAI's, Anthropic's, and Gemini's rules for a
function name."""


def test_the_name_carries_the_trial_id():
    name = cache_bust_tool_name("tau3-banking_knowledge-task-047__C6gys3m")
    assert name == "cache_bust_tau3-banking_knowledge-task-047__C6gys3m"
    assert NAME.match(name)
    assert name.startswith(CACHE_BUST_TOOL_PREFIX)


def test_characters_no_provider_accepts_are_replaced():
    name = cache_bust_tool_name("task.one|x y")
    assert name == "cache_bust_task_one_x_y" and NAME.match(name)


def test_a_long_trial_id_becomes_a_digest_of_itself():
    long_id = "toolathlon-" + "x" * 80 + "__abcdef1"
    name = cache_bust_tool_name(long_id)
    assert NAME.match(name) and len(name) <= 64
    assert name == cache_bust_tool_name(long_id)
    assert name != cache_bust_tool_name(long_id[:-1] + "2")
    assert name.startswith(CACHE_BUST_TOOL_PREFIX)


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini"])
def test_every_adapter_takes_the_tool(provider):
    tool = cache_bust_tool("t__1")
    [schema] = function_schemas([tool])
    assert schema.name == "cache_bust_t__1"
    assert schema.description == "Never call this tool."
    payload = adapter_for(provider).initial_payload(
        model="m", system=None, opening=[], tools=[tool], reasoning_effort=None
    )
    assert "cache_bust_t__1" in str(payload["tools"])
