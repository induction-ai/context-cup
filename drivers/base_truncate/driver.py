"""Clip oversized tool results before they reach the model. The simplest
thing that is not nothing, and an example of editing a native payload."""

from __future__ import annotations

from typing import Any

from context_cup_engine import Payload, TurnContext

MARKER = "\n\n[truncated by base_truncate: {dropped} bytes removed]"


def clip(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text
    kept = raw[:max_bytes].decode("utf-8", errors="ignore")
    return kept + MARKER.format(dropped=len(raw) - max_bytes)


def clip_openai(payload: Payload, max_bytes: int) -> None:
    for item in payload.get("input", []):
        if item.get("type") == "function_call_output" and isinstance(
            item.get("output"), str
        ):
            item["output"] = clip(item["output"], max_bytes)


def clip_anthropic(payload: Payload, max_bytes: int) -> None:
    for message in payload.get("messages", []):
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if block.get("type") == "tool_result" and isinstance(
                block.get("content"), str
            ):
                block["content"] = clip(block["content"], max_bytes)


def clip_gemini(payload: Payload, max_bytes: int) -> None:
    for content in payload.get("contents", []):
        for part in content.get("parts", []):
            response: Any = (part.get("functionResponse") or {}).get("response")
            if isinstance(response, dict) and isinstance(response.get("result"), str):
                response["result"] = clip(response["result"], max_bytes)


CLIPPERS = {"openai": clip_openai, "anthropic": clip_anthropic, "gemini": clip_gemini}


def run(ctx: TurnContext) -> Payload:
    max_bytes = int(ctx.config.get("max_bytes", 100_000))
    CLIPPERS[ctx.provider](ctx.context_payload, max_bytes)
    return ctx.call(ctx.context_payload)
