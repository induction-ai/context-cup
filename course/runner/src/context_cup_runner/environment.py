"""What a benchmark environment looks like to the loop.

The loop never talks to MCP or a benchmark runtime directly. It opens the
environment, hands it the tool calls or the plain text the model produced,
appends whatever the environment answers, and stops when it says so.
Everything crosses this boundary in provider-neutral form; the provider
adapter turns it into the payload.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from context_cup_protocol import ToolCallRef, Utterance


@dataclass
class EnvironmentStart:
    system: str | None
    opening: list[Utterance]
    tools: list[dict[str, Any]]
    """OpenAI function schemas (`mcp_util.mcp_tool_to_function_tool`)."""
    workspace_dir: str | None = None
    stop_reason: str | None = None


@dataclass
class ToolResult:
    tool_call_id: str
    content: str


@dataclass
class StepResult:
    """What the environment hands back after one model action."""

    tool_results: list[ToolResult] = field(default_factory=list)
    user_messages: list[str] = field(default_factory=list)
    stop_reason: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class Environment(Protocol):
    name: str

    async def open(self) -> EnvironmentStart: ...

    async def on_tool_calls(
        self, tool_calls: list[ToolCallRef], text: str | None
    ) -> StepResult: ...

    async def on_message(self, text: str) -> StepResult: ...

    async def close(self, stop_reason: str) -> dict[str, Any]:
        """Release resources and return benchmark-specific summary fields."""
        ...
