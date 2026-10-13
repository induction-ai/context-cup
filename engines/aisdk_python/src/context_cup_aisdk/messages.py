"""The course's conversation in the AI SDK for Python's terms: `Message`s,
and `Tool`s for the course's tools with nothing to run them, so a call stops
at the model's tool calls and the course runs them.

Each provider's reasoning rides along where the SDK reads it back: an
OpenAI reasoning item as a reasoning part carrying the item itself, which
the SDK replays verbatim (encrypted content and all), and an Anthropic
thinking block as a reasoning part with its signature. Without them a
reasoning model starts every turn cold. What has no SDK form (a redacted
thinking block, a hosted tool's call) is not carried."""

from __future__ import annotations

import json
from typing import Any

import ai
from ai.types.messages import Message, Part, ToolCallPart
from ai.types.tools import ToolSpec

from context_cup_protocol import Conversation, Provider
from context_cup_protocol.view import Message as ViewMessage

Native = dict[str, Any]


def reasoning(provider: Provider, fragment: Native) -> list[Part]:
    """An opaque fragment of an assistant message as reasoning parts."""
    if provider == "openai" and fragment.get("type") == "reasoning":
        summaries = [s.get("text") or "" for s in fragment.get("summary") or []]
        # The SDK sends `raw_item` back as it is; the text is for readers.
        return [
            ai.thinking(
                "\n\n".join(summaries),
                provider_metadata={"openai": {"raw_item": fragment}},
            )
        ]
    if provider == "anthropic" and fragment.get("type") == "thinking":
        return [
            ai.thinking(
                fragment.get("thinking") or "",
                provider_metadata={
                    "anthropic": {"signature": fragment.get("signature")}
                },
            )
        ]
    return []


def assistant(provider: Provider, m: ViewMessage) -> Message | None:
    parts: list[Part] = [p for o in m.opaque for p in reasoning(provider, o)]
    if m.text:
        parts.append(ai.text_part(m.text))
    for call in m.tool_calls:
        parts.append(
            ToolCallPart(
                tool_call_id=call.id,
                tool_name=call.name,
                tool_args=json.dumps(call.arguments),
            )
        )
    return ai.assistant_message(*parts) if parts else None


def model_messages(
    provider: Provider, conversation: Conversation, start: int = 0
) -> list[Message]:
    """The conversation from message `start` on as SDK messages, with the
    system prompt first as a system message when `start` is 0. Consecutive
    tool results share one tool message, which is how a provider expects
    the answers to one turn's calls."""
    names = {c.id: c.name for m in conversation.messages for c in m.tool_calls}
    out: list[Message] = []
    if conversation.system and start == 0:
        out.append(ai.system_message(conversation.system))
    for m in conversation.messages[start:]:
        if m.role == "tool":
            call_id = m.tool_call_id or ""
            part = ai.tool_result_part(
                call_id, result=m.text or "", tool_name=names.get(call_id, "")
            )
            if out and out[-1].role == "tool":
                out[-1].parts.append(part)
            else:
                out.append(ai.tool_message(part))
        elif m.role == "user":
            if m.text:
                out.append(ai.user_message(m.text))
        else:
            message = assistant(provider, m)
            if message is not None:
                out.append(message)
    return out


def model_tools(conversation: Conversation) -> list[ai.Tool]:
    """The course's tools as SDK tools, with nothing to run them."""
    return [
        ai.Tool(
            kind="function",
            name=t.name,
            spec=ToolSpec(
                description=t.description,
                params=t.parameters or {"type": "object", "properties": {}},
            ),
        )
        for t in conversation.tools
    ]
