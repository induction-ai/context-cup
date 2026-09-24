"""base_litellm: clip any tool result larger than `config.max_bytes` before
it reaches the model. base_python, on LiteLLM: copy this to write one
strategy for OpenAI, Anthropic, and Gemini over chat messages: edit
`ctx.context_messages`, call `ctx.llm.completion()`, return its response.
See engines/litellm/README.md for everything `ctx` holds."""

from typing import Any

MARKER = "\n\n[truncated by base_litellm: {dropped} bytes removed]"
MARKER_PREFIX = "\n\n[truncated by base_litellm:"


def clip(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    # Clipped edits persist in context_messages, so a result clipped on an
    # earlier turn comes back with its marker; leave it as it is.
    if len(raw) <= max_bytes or MARKER_PREFIX in text:
        return text
    kept = raw[:max_bytes].decode("utf-8", errors="ignore")
    return kept + MARKER.format(dropped=len(raw) - max_bytes)


def run(ctx: Any) -> Any:
    # Tunables live in package.json's contextCup.config, so a variant is a
    # manifest edit.
    max_bytes = int(ctx.config.get("max_bytes", 100_000))
    # `ctx.context_messages` is litellm chat messages: turn one, the whole
    # conversation; after that, last turn's list as this driver left it plus
    # the model's reply and the new tool results or user text. Tool results
    # are `tool` messages with string content. The clip persists: next turn
    # starts from the clipped list.
    for message in ctx.context_messages:
        if message["role"] == "tool" and isinstance(message.get("content"), str):
            message["content"] = clip(message["content"], max_bytes)
    # With no arguments, ctx.llm sends ctx.context_messages and ctx.tools to
    # the target through the trial's proxy. The engine emits the raw provider
    # body behind this response as the turn's answer.
    return ctx.llm.completion()
