"""Build a harbor ATIF-v1.7 trajectory from the original payload (through the
provider adapter) and the per-turn driver outputs. Shapes follow
harbor.models.trajectories; harbor itself is not imported so the loop runs
inside a bare task container."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .protocol import Target
from .providers.base import Step

ATIF_VERSION = "ATIF-v1.7"
AGENT_NAME = "context-cup-runner"


@dataclass
class TurnRecord:
    """Everything the driver produced for one turn. Agent steps in the
    payload and turn records line up one to one, in order."""

    turn_id: str


def build_trajectory(
    *,
    trial_id: str,
    steps: list[Step],
    turns: list[TurnRecord],
    target: Target,
    tools: list[dict[str, Any]],
    runner_version: str,
    driver: dict[str, Any] | None,
) -> dict[str, Any]:
    out: list[dict[str, Any]] = []
    agent_index = 0
    for step in steps:
        record: dict[str, Any] = {"source": step.source, "message": step.message}
        if step.source == "agent":
            if step.tool_calls:
                record["tool_calls"] = [
                    {
                        "tool_call_id": call.id,
                        "function_name": call.name,
                        "arguments": call.arguments,
                    }
                    for call in step.tool_calls
                ]
            if step.results:
                record["observation"] = {
                    "results": [
                        {"source_call_id": call_id, "content": content}
                        for call_id, content in step.results
                    ]
                }
            turn = turns[agent_index] if agent_index < len(turns) else None
            agent_index += 1
            if turn is not None:
                # Token accounting lives in the proxy log on the host.
                record["extra"] = {"turn_id": turn.turn_id}
        out.append(record)

    for step_id, record in enumerate(out, start=1):
        record["step_id"] = step_id

    return {
        "schema_version": ATIF_VERSION,
        "session_id": trial_id,
        "agent": {
            "name": AGENT_NAME,
            "version": runner_version,
            "model_name": target.model,
            "tool_definitions": tools,
            "extra": {"driver": driver, "target": target.model_dump(mode="json")},
        },
        "steps": out,
        "final_metrics": {"total_steps": len(out)},
    }
