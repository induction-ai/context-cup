"""Gemini, generateContent.

Request: {model, systemInstruction: {parts}, contents: [{role, parts}], tools:
[{functionDeclarations}], generationConfig: {thinkingConfig}}. Response: the
GenerateContentResponse; `candidates[0].content` (thought signatures and all)
becomes the next model turn verbatim, and tool results go back as
functionResponse parts in one user content.

Function calls carry an `id` only on some API versions; when absent the
adapter mints one per turn so the environment still sees a stable id, and
the functionResponse then goes back by name alone.
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

THINKING_BUDGETS = {"low": 1_024, "medium": 8_192, "high": 24_576}
CONVERSATION_START = "(Start of conversation)"
MINTED_PREFIX = "gemini-call-"


def _parts_text(parts: Any) -> str:
    texts: list[str] = []
    for part in parts or []:
        if (
            isinstance(part, dict)
            and isinstance(part.get("text"), str)
            and not part.get("thought")
        ):
            texts.append(part["text"])
    return "\n".join(texts)


def _calls_in_parts(parts: Any, *, turn_key: str) -> list[ToolCallRef]:
    calls: list[ToolCallRef] = []
    for index, part in enumerate(parts or []):
        if not isinstance(part, dict):
            continue
        call = part.get("functionCall")
        if not isinstance(call, dict):
            continue
        calls.append(
            ToolCallRef(
                id=str(call.get("id") or f"{MINTED_PREFIX}{turn_key}-{index}"),
                name=str(call.get("name") or ""),
                arguments=parse_arguments(call.get("args")),
            )
        )
    return calls


class GeminiAdapter:
    provider = "gemini"

    def initial_payload(
        self,
        *,
        model: str,
        system: str | None,
        opening: list[Utterance],
        tools: list[dict[str, Any]],
        reasoning_effort: str | None,
    ) -> Payload:
        payload: Payload = {"model": model, "contents": []}
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        schemas = function_schemas(tools)
        if schemas:
            payload["tools"] = [
                {
                    "functionDeclarations": [
                        {
                            "name": schema.name,
                            "description": schema.description,
                            # The JSON Schema as MCP gives it: `parameters`
                            # takes only an OpenAPI subset and rejects keys
                            # such as additionalProperties.
                            "parametersJsonSchema": schema.parameters,
                        }
                        for schema in schemas
                    ]
                }
            ]
        budget = THINKING_BUDGETS.get(reasoning_effort or "")
        if budget is not None:
            payload["generationConfig"] = {"thinkingConfig": {"thinkingBudget": budget}}
        for turn in opening:
            if turn.role == "user":
                self.append_user(payload, turn.text)
            else:
                contents = payload["contents"]
                if not contents:
                    contents.append(
                        {"role": "user", "parts": [{"text": CONVERSATION_START}]}
                    )
                contents.append({"role": "model", "parts": [{"text": turn.text}]})
        return payload

    def _candidate_parts(self, response: Payload) -> list[Any]:
        candidates = response.get("candidates") or []
        if not candidates or not isinstance(candidates[0], dict):
            return []
        content = candidates[0].get("content") or {}
        parts = content.get("parts") if isinstance(content, dict) else None
        return list(parts) if isinstance(parts, list) else []

    def extract(self, response: Payload) -> Extracted:
        parts = self._candidate_parts(response)
        text = _parts_text(parts)
        turn_key = str(response.get("responseId") or len(parts))
        return Extracted(
            text=text or None, tool_calls=_calls_in_parts(parts, turn_key=turn_key)
        )

    def append_response(self, payload: Payload, response: Payload) -> None:
        candidates = response.get("candidates") or []
        content = candidates[0].get("content") if candidates else None
        if not isinstance(content, dict):
            content = {"role": "model", "parts": []}
        content = dict(content)
        content.setdefault("role", "model")
        # Keep the minted ids reachable: the functionResponse must match by
        # name when the API gave no id, so nothing to store here.
        payload.setdefault("contents", []).append(content)

    def append_tool_results(
        self, payload: Payload, results: list[tuple[ToolCallRef, str]]
    ) -> None:
        if not results:
            return
        parts = []
        for call, output in results:
            response: dict[str, Any] = {
                "name": call.name,
                "response": {"result": output},
            }
            if not call.id.startswith(MINTED_PREFIX):
                response["id"] = call.id
            parts.append({"functionResponse": response})
        payload.setdefault("contents", []).append({"role": "user", "parts": parts})

    def append_user(self, payload: Payload, text: str) -> None:
        payload.setdefault("contents", []).append(
            {"role": "user", "parts": [{"text": text}]}
        )

    def steps_from_payload(self, payload: Payload) -> list[Step]:
        steps: list[Step] = []
        system = payload.get("systemInstruction")
        if isinstance(system, dict):
            text = _parts_text(system.get("parts"))
            if text:
                steps.append(Step(source="system", message=text))
        agent: Step | None = None
        for index, content in enumerate(payload.get("contents") or []):
            if not isinstance(content, dict):
                continue
            parts = content.get("parts") or []
            if content.get("role") == "model":
                agent = Step(
                    source="agent",
                    message=_parts_text(parts),
                    tool_calls=_calls_in_parts(parts, turn_key=str(index)),
                )
                steps.append(agent)
                continue
            responses = [
                p["functionResponse"]
                for p in parts
                if isinstance(p, dict) and isinstance(p.get("functionResponse"), dict)
            ]
            if responses and agent is not None:
                for position, item in enumerate(responses):
                    call_id = str(item.get("id") or "")
                    if not call_id and position < len(agent.tool_calls):
                        call_id = agent.tool_calls[position].id
                    result = item.get("response")
                    output = (
                        result.get("result") if isinstance(result, dict) else result
                    )
                    agent.results.append(
                        (call_id, str(output if output is not None else ""))
                    )
            text = _parts_text(parts)
            if text and text != CONVERSATION_START:
                steps.append(Step(source="user", message=text))
        return steps
