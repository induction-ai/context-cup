"""base_python: clip any tool result larger than `config.max_bytes` before
it reaches the model. The Python engine's lane with a real edit: copy this to
write one strategy that works on every provider through the provider-neutral
view, while the native payload changes only where you changed something.
See engines/python/README.md for everything `ctx` holds."""

from typing import Any

import httpx
from anthropic import Anthropic
from context_cup_engine import PythonContext
from openai import OpenAI

MARKER = "\n\n[truncated by base_python: {dropped} bytes removed]"
MARKER_PREFIX = "\n\n[truncated by base_python:"


def clip(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    # Clipped edits persist in context_payload, so a result clipped on an
    # earlier turn comes back with its marker; leave it as it is.
    if len(raw) <= max_bytes or MARKER_PREFIX in text:
        return text
    kept = raw[:max_bytes].decode("utf-8", errors="ignore")
    return kept + MARKER.format(dropped=len(raw) - max_bytes)


def call(ctx: PythonContext) -> Any:
    """Send `context_payload` to the run's provider. Each SDK already points at
    the trial's proxy (base URL and placeholder key set by the runner), so none
    needs configuring; the proxy adds the real key and records the call."""
    payload = ctx.context_payload
    if ctx.provider.name == "openai":
        return OpenAI().responses.create(**payload)
    if ctx.provider.name == "anthropic":
        return Anthropic().messages.create(**payload)
    # Gemini: the model goes in the path, the rest of the payload is the body.
    body = {k: v for k, v in payload.items() if k != "model"}
    url = f"{ctx.provider.client.base_url}/models/{payload['model']}:generateContent"
    response = httpx.post(
        url, json=body, headers={"x-goog-api-key": ctx.provider.api_key}, timeout=600
    )
    response.raise_for_status()
    return response.json()


def run(ctx: PythonContext) -> Any:
    # Tunables live in package.json's contextCup.config, so a variant is a
    # manifest edit.
    max_bytes = int(ctx.config.get("max_bytes", 100_000))
    # The view reads the native payload as system text, messages, and tools,
    # the same for OpenAI, Anthropic, and Gemini. What it doesn't model
    # (reasoning items, thinking blocks, thought signatures) rides along.
    conversation = ctx.view()
    for message in conversation.messages:
        if message.role == "tool" and message.text:
            message.text = clip(message.text, max_bytes)
    # Write the edits back: only the clipped results change in the payload.
    # The clip persists, since the course keeps this payload for next turn
    # and appends to it.
    ctx.write(conversation)
    return call(ctx)
