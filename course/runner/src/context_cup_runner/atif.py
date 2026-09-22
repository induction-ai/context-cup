"""Build a harbor ATIF-v1.7 trajectory from the original payload (through the
provider adapter) and the per-turn driver outputs. Shapes follow
harbor.models.trajectories; harbor itself is not imported so the loop runs
inside a bare task container."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .protocol import Call, Target, Usage
from .providers.base import Step

ATIF_VERSION = "ATIF-v1.7"
AGENT_NAME = "context-cup-runner"


@dataclass
class TurnRecord:
    """Everything the driver produced for one turn. Agent steps in the
    payload and turn records line up one to one, in order."""

    turn_id: str
    calls: list[Call]


def build_trajectory(
    *,
    trial_id: str,
    steps: list[Step],
    turns: list[TurnRecord],
    target: Target,
    tools: list[dict[str, Any]],
    totals: Usage,
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
                record["llm_call_count"] = len(turn.calls)
                if turn.calls:
                    usage = Usage()
                    for call in turn.calls:
                        usage.add(call.usage)
                    record["metrics"] = {
                        "prompt_tokens": usage.input,
                        "completion_tokens": usage.output,
                        "cached_tokens": usage.cached_input,
                        "extra": {
                            "cache_write_tokens": usage.cache_write_input,
                            "reasoning_tokens": usage.reasoning_output,
                            "calls": [c.model_dump(mode="json") for c in turn.calls],
                        },
                    }
                extra: dict[str, Any] = {"turn_id": turn.turn_id}
                record["extra"] = extra
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
        "final_metrics": {
            "total_prompt_tokens": totals.input,
            "total_completion_tokens": totals.output,
            "total_cached_tokens": totals.cached_input,
            "total_steps": len(out),
            "extra": {
                "cache_write_tokens": totals.cache_write_input,
                "reasoning_tokens": totals.reasoning_output,
            },
        },
    }
