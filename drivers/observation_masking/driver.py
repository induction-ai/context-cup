"""observation_masking: replace every tool result older than the last
`config.window` assistant turns with a one-line placeholder, keeping all
reasoning and tool calls. A reproduction of observation masking from "The
Complexity Trap" (Lindenbauer et al., NeurIPS 2025); README.md explains the
strategy, engines/python/README.md everything `ctx` holds."""

from typing import Any

import httpx
from anthropic import Anthropic
from openai import OpenAI

from context_cup_engine import PythonContext
from context_cup_protocol.view import Conversation, Message

PLACEHOLDER = "Old environment output: ({lines} lines omitted)"
PLACEHOLDER_PREFIX = "Old environment output: ("


def mask(text: str) -> str:
    # Leave previously-masked text as-is.
    if text.startswith(PLACEHOLDER_PREFIX):
        return text
    return PLACEHOLDER.format(lines=len(text.splitlines()))


def masked_call_ids(messages: list[Message], window: int) -> set[str]:
    """The tool calls made before the last `window` assistant turns that
    called a tool. One turn's parallel calls count as one turn."""
    turns = [m for m in messages if m.role == "assistant" and m.tool_calls]
    old = turns[:-window] if window > 0 else turns
    return {call.id for turn in old for call in turn.tool_calls}


def mask_old(conversation: Conversation, window: int) -> None:
    old = masked_call_ids(conversation.messages, window)
    for message in conversation.messages:
        if message.role == "tool" and message.tool_call_id in old and message.text:
            message.text = mask(message.text)


def call(ctx: PythonContext) -> Any:
    """Send `context_payload` to the run's provider, as base_python does."""
    payload = ctx.context_payload
    if ctx.provider.name == "openai":
        return OpenAI().responses.create(**payload)
    if ctx.provider.name == "anthropic":
        return Anthropic().messages.create(**payload)
    body = {k: v for k, v in payload.items() if k != "model"}
    url = f"{ctx.provider.client.base_url}/models/{payload['model']}:generateContent"
    response = httpx.post(
        url, json=body, headers={"x-goog-api-key": ctx.provider.api_key}, timeout=600
    )
    response.raise_for_status()
    return response.json()


def run(ctx: PythonContext) -> Any:
    conversation = ctx.view()
    mask_old(conversation, int(ctx.config.get("window", 10)))
    # Only the newly masked results change in the payload
    ctx.write(conversation)
    return call(ctx)
