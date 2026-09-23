"""Anthropic, Messages API.

Request: {model, system, messages: [{role, content: [blocks]}], tools,
max_tokens, thinking}. Response: the Message object; its `content` blocks
(thinking, text, tool_use) become the next assistant message verbatim, and
tool results go back as tool_result blocks in one user message.
"""

from __future__ import annotations

from typing import Any

from .base import (
    Extracted,
    Payload,
    Step,
    ToolCallRef,
    Utterance,
    function_schemas,
    parse_arguments,
)

DEFAULT_MAX_TOKENS = 16_384
# reasoning_effort -> thinking budget tokens. Absent or "none" leaves
# thinking off.
THINKING_BUDGETS = {"low": 2_048, "medium": 8_192, "high": 32_768}
CONVERSATION_START = "(Start of conversation)"


def _blocks_text(blocks: Any) -> str:
    if isinstance(blocks, str):
        return blocks
    parts: list[str] = []
    for block in blocks or []:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


class AnthropicAdapter:
    provider = "anthropic"

    def initial_payload(
        self,
        *,
        model: str,
        system: str | None,
        opening: list[Utterance],
        tools: list[dict[str, Any]],
        reasoning_effort: str | None,
    ) -> Payload:
        payload: Payload = {
            "model": model,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "messages": [],
            "tools": [
                {
                    "name": schema.name,
                    "description": schema.description,
                    "input_schema": schema.parameters,
                }
                for schema in function_schemas(tools)
            ],
        }
        if system:
            payload["system"] = system
        budget = THINKING_BUDGETS.get(reasoning_effort or "")
        if budget is not None:
            payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
            if payload["max_tokens"] <= budget:
                payload["max_tokens"] = budget + DEFAULT_MAX_TOKENS
        for turn in opening:
            if turn.role == "user":
                self.append_user(payload, turn.text)
            else:
                self._append_assistant_text(payload, turn.text)
        return payload

    def _append_assistant_text(self, payload: Payload, text: str) -> None:
        messages = payload.setdefault("messages", [])
        if not messages:
            # The API requires the first message to be the user's.
            messages.append(
                {
                    "role": "user",
                    "content": [{"type": "text", "text": CONVERSATION_START}],
                }
            )
        messages.append(
            {"role": "assistant", "content": [{"type": "text", "text": text}]}
        )

    def extract(self, response: Payload) -> Extracted:
        texts: list[str] = []
        calls: list[ToolCallRef] = []
        for block in response.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                if block["text"]:
                    texts.append(block["text"])
            elif block.get("type") == "tool_use":
                calls.append(
                    ToolCallRef(
                        id=str(block.get("id") or ""),
                        name=str(block.get("name") or ""),
                        arguments=parse_arguments(block.get("input")),
                    )
                )
        return Extracted(text="\n".join(texts) if texts else None, tool_calls=calls)

    def append_response(self, payload: Payload, response: Payload) -> None:
        blocks = [b for b in response.get("content") or [] if isinstance(b, dict)]
        payload.setdefault("messages", []).append(
            {"role": "assistant", "content": blocks}
        )

    def append_tool_results(
        self, payload: Payload, results: list[tuple[ToolCallRef, str]]
    ) -> None:
        if not results:
            return
        payload.setdefault("messages", []).append(
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": call.id, "content": output}
                    for call, output in results
                ],
            }
        )

    def append_user(self, payload: Payload, text: str) -> None:
        payload.setdefault("messages", []).append(
            {"role": "user", "content": [{"type": "text", "text": text}]}
        )

    def steps_from_payload(self, payload: Payload) -> list[Step]:
        steps: list[Step] = []
        system = payload.get("system")
        if isinstance(system, str) and system:
            steps.append(Step(source="system", message=system))
        elif isinstance(system, list):
            steps.append(Step(source="system", message=_blocks_text(system)))
        agent: Step | None = None
        for message in payload.get("messages") or []:
            if not isinstance(message, dict):
                continue
            content = message.get("content")
            if message.get("role") == "assistant":
                agent = Step(source="agent", message=_blocks_text(content))
                for block in content if isinstance(content, list) else []:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        agent.tool_calls.append(
                            ToolCallRef(
                                id=str(block.get("id") or ""),
                                name=str(block.get("name") or ""),
                                arguments=parse_arguments(block.get("input")),
                            )
                        )
                steps.append(agent)
                continue
            blocks = content if isinstance(content, list) else []
            tool_results = [
                b
                for b in blocks
                if isinstance(b, dict) and b.get("type") == "tool_result"
            ]
            if tool_results and agent is not None:
                for block in tool_results:
                    agent.results.append(
                        (
                            str(block.get("tool_use_id") or ""),
                            _blocks_text(block.get("content"))
                            if isinstance(block.get("content"), list)
                            else str(block.get("content") or ""),
                        )
                    )
            text = _blocks_text(content)
            if text and text != CONVERSATION_START:
                steps.append(Step(source="user", message=text))
        return steps
