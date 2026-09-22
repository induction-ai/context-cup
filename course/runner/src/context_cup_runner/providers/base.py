"""Types every adapter shares."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Payload = dict[str, Any]
"""A provider request or response body, as JSON."""


@dataclass(frozen=True)
class Utterance:
    """A plain-text turn the course adds: the task's opening, a simulated
    user's reply, the agent's canned greeting."""

    role: Literal["user", "assistant"]
    text: str


@dataclass(frozen=True)
class ToolCallRef:
    """A tool call the model made, in provider-neutral form for the
    environment. `id` is the provider's call id, or one the adapter minted
    when the API has none."""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class Extracted:
    """What a response asks the course to do."""

    text: str | None
    tool_calls: list[ToolCallRef] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not (self.text and self.text.strip()) and not self.tool_calls


@dataclass
class Step:
    """One conversation step in a provider-neutral shape, for the ATIF
    trajectory. `source` follows ATIF: system, user, agent."""

    source: Literal["system", "user", "agent"]
    message: str
    tool_calls: list[ToolCallRef] = field(default_factory=list)
    results: list[tuple[str, str]] = field(default_factory=list)
    """(call id, content) for the tool results that answered this step."""


@dataclass(frozen=True)
class FunctionSchema:
    """A tool as the environments describe it: the OpenAI function schema
    shape mcp_util produces. Adapters convert to their provider's format."""

    name: str
    description: str
    parameters: dict[str, Any]


def function_schemas(tools: list[dict[str, Any]]) -> list[FunctionSchema]:
    out = []
    for tool in tools:
        function = tool.get("function") or {}
        name = function.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError(f"tool without a name: {tool!r}")
        parameters = function.get("parameters") or {"type": "object", "properties": {}}
        if not isinstance(parameters, dict):
            raise TypeError(f"tool {name}: parameters must be an object")
        out.append(
            FunctionSchema(
                name=name,
                description=str(function.get("description") or ""),
                parameters=parameters,
            )
        )
    return out


def parse_arguments(raw: Any) -> dict[str, Any]:
    """Tool arguments as a dict; a string is parsed as JSON. Anything that is
    not an object comes back under `_raw` so the call still reaches the
    environment and the model sees the error."""
    if isinstance(raw, dict):
        return raw
    if raw is None or raw == "":
        return {}
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {"_raw": raw}
        return parsed if isinstance(parsed, dict) else {"_raw": raw}
    return {"_raw": raw}


class ProviderAdapter(Protocol):
    provider: str

    def initial_payload(
        self,
        *,
        model: str,
        system: str | None,
        opening: list[Utterance],
        tools: list[dict[str, Any]],
        reasoning_effort: str | None,
    ) -> Payload:
        """The first request body: system prompt, tools, the opening turns,
        and the reasoning setting in the provider's own terms."""
        ...

    def extract(self, response: Payload) -> Extracted:
        """The text and tool calls a response carries."""
        ...

    def append_response(self, payload: Payload, response: Payload) -> None:
        """Append the response's output to the request body, verbatim."""
        ...

    def append_tool_results(
        self, payload: Payload, results: list[tuple[ToolCallRef, str]]
    ) -> None: ...

    def append_user(self, payload: Payload, text: str) -> None: ...

    def steps_from_payload(self, payload: Payload) -> list[Step]:
        """The conversation the payload holds, in provider-neutral steps."""
        ...


def ensure_json_dict(value: Any, what: str) -> Payload:
    """`value` as a JSON-serialisable dict, or a clear error."""
    if not isinstance(value, dict):
        raise TypeError(f"{what} must be a JSON object, not {type(value).__name__}")
    try:
        json.dumps(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{what} is not JSON-serialisable: {exc}") from None
    return value
