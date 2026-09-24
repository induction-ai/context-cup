"""base_litellm: LiteLLM's own trimming, the default for litellm-based
drivers. The working conversation is cut to fit the model's context window
with `litellm.utils.trim_messages`, then sent through the engine's
connection. `config.max_tokens` sets the budget; unset, litellm uses 75% of
the model's input window, which most tasks never reach.

Copy this to write one strategy for OpenAI, Anthropic, and Gemini over chat
messages: edit `ctx.context_messages`, call `ctx.llm.completion()`, return
its response. See engines/litellm/README.md for everything `ctx` holds."""

import copy
from typing import Any

from litellm.utils import trim_messages


def keep_tool_pairs(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Trimming drops oldest messages first and can split a tool call from its
    result; a provider rejects either half on its own, so drop the orphans."""
    answered = {m.get("tool_call_id") for m in messages if m.get("role") == "tool"}
    out: list[dict[str, Any]] = []
    for m in messages:
        calls = m.get("tool_calls")
        if m.get("role") == "assistant" and calls:
            kept = [c for c in calls if c.get("id") in answered]
            if not kept and not m.get("content"):
                continue
            m = {**m, "tool_calls": kept or None}
        out.append(m)
    called = {c.get("id") for m in out for c in (m.get("tool_calls") or [])}
    return [
        m for m in out if m.get("role") != "tool" or m.get("tool_call_id") in called
    ]


def run(ctx):
    # `ctx.context_messages` is litellm chat messages: turn one, the whole
    # conversation; after that, last turn's list as this driver left it plus
    # the model's reply and the new tool results or user text.
    #
    # Assigning it back is what persists the trim: next turn starts from the
    # trimmed list and only the new messages are added to it.
    ctx.context_messages = keep_tool_pairs(
        trim_messages(
            copy.deepcopy(ctx.context_messages),
            model=ctx.target.model,
            max_tokens=ctx.config.get("max_tokens"),
        )
    )
    # With no arguments, ctx.llm sends ctx.context_messages and ctx.tools to
    # the target through the trial's proxy. The engine emits the raw provider
    # body behind this response as the turn's answer.
    return ctx.llm.completion()
