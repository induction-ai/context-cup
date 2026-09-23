"""Clip oversized tool results before they reach the model: one function for
every provider, through the provider-neutral view, so the native payload
changes only where a result was clipped."""

from typing import Any

import httpx
from anthropic import Anthropic
from context_cup_engine import PythonContext
from openai import OpenAI

MARKER = "\n\n[truncated by base_truncate: {dropped} bytes removed]"


def clip(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text
    kept = raw[:max_bytes].decode("utf-8", errors="ignore")
    return kept + MARKER.format(dropped=len(raw) - max_bytes)


def call(ctx: PythonContext) -> Any:
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
    max_bytes = int(ctx.config.get("max_bytes", 100_000))
    conversation = ctx.view()
    for message in conversation.messages:
        if message.role == "tool" and message.text:
            message.text = clip(message.text, max_bytes)
    ctx.write(conversation)
    return call(ctx)
