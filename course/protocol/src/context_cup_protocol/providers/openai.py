"""OpenAI, Responses API.

Request: {model, instructions, input: [items], tools, reasoning, store: false,
include: ["reasoning.encrypted_content"]}. Response: the Responses object;
its `output` items (reasoning, message, function_call) are appended to
`input` verbatim so reasoning carries across turns without server-side
storage.
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


def _text_of_message_item(item: dict[str, Any]) -> str:
    content = item.get("content")
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for part in content or []:
        if not isinstance(part, dict):
            continue
        if part.get("type") in ("output_text", "input_text", "text") and isinstance(
            part.get("text"), str
        ):
            parts.append(part["text"])
    return "\n".join(parts)


class OpenAIAdapter:
    provider = "openai"

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
            "input": [{"role": turn.role, "content": turn.text} for turn in opening],
            "tools": [
                {
                    "type": "function",
                    "name": schema.name,
                    "description": schema.description,
                    "parameters": schema.parameters,
                }
                for schema in function_schemas(tools)
            ],
            "store": False,
            "include": ["reasoning.encrypted_content"],
        }
        if system:
            payload["instructions"] = system
        if reasoning_effort and reasoning_effort != "none":
            payload["reasoning"] = {"effort": reasoning_effort}
        return payload

    def extract(self, response: Payload) -> Extracted:
        texts: list[str] = []
        calls: list[ToolCallRef] = []
        for item in response.get("output") or []:
            if not isinstance(item, dict):
                continue
            kind = item.get("type")
            if kind == "message":
                text = _text_of_message_item(item)
                if text:
                    texts.append(text)
            elif kind == "function_call":
                calls.append(
                    ToolCallRef(
                        id=str(item.get("call_id") or item.get("id") or ""),
                        name=str(item.get("name") or ""),
                        arguments=parse_arguments(item.get("arguments")),
                    )
                )
        return Extracted(text="\n".join(texts) if texts else None, tool_calls=calls)

    def append_response(self, payload: Payload, response: Payload) -> None:
        items = [i for i in response.get("output") or [] if isinstance(i, dict)]
        payload.setdefault("input", []).extend(items)

    def append_tool_results(
        self, payload: Payload, results: list[tuple[ToolCallRef, str]]
    ) -> None:
        payload.setdefault("input", []).extend(
            {"type": "function_call_output", "call_id": call.id, "output": output}
            for call, output in results
        )

    def append_user(self, payload: Payload, text: str) -> None:
        payload.setdefault("input", []).append({"role": "user", "content": text})

    def steps_from_payload(self, payload: Payload) -> list[Step]:
        steps: list[Step] = []
        instructions = payload.get("instructions")
        if isinstance(instructions, str) and instructions:
            steps.append(Step(source="system", message=instructions))
        agent: Step | None = None
        for item in payload.get("input") or []:
            if not isinstance(item, dict):
                continue
            kind = item.get("type")
            role = item.get("role")
            if kind == "function_call":
                if agent is None:
                    agent = Step(source="agent", message="")
                    steps.append(agent)
                agent.tool_calls.append(
                    ToolCallRef(
                        id=str(item.get("call_id") or ""),
                        name=str(item.get("name") or ""),
                        arguments=parse_arguments(item.get("arguments")),
                    )
                )
            elif kind == "function_call_output":
                if agent is not None:
                    agent.results.append(
                        (str(item.get("call_id") or ""), str(item.get("output") or ""))
                    )
            elif role == "assistant" or kind == "message" and role != "user":
                text = _text_of_message_item(item)
                if agent is None or agent.results:
                    agent = Step(source="agent", message=text)
                    steps.append(agent)
                elif text:
                    agent.message = (agent.message + "\n" + text).strip()
            elif role == "user":
                agent = None
                steps.append(Step(source="user", message=_text_of_message_item(item)))
            # reasoning and other items carry no conversation text
        return steps
