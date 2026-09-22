"""Shared fixtures: a fake engine that answers with canned provider-native
responses and an in-memory environment, so the loop runs with no network or
docker."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest
from context_cup_runner.chain import DriverChain
from context_cup_runner.environment import EnvironmentStart, StepResult, ToolResult
from context_cup_runner.loop import Settings
from context_cup_runner.protocol import Target
from context_cup_runner.providers import ToolCallRef, Utterance

# The fake engine reads a script of steps from the driver dir. Each step says
# what the "model" replied: `text`, `tool_calls` [{id, name, args}], plus
# failure modes. It renders the reply in the input's provider format.
FAKE_ENGINE = """
import json, os, sys
from pathlib import Path

input_path, output_path = sys.argv[1], sys.argv[2]
inp = json.loads(Path(input_path).read_text())
script_path = Path(os.environ["CC_DRIVER_DIR"]) / "script.json"
assert os.environ["CC_TURN_DIR"] == str(Path(input_path).parent)
assert os.environ["CC_CHAIN"].split(":")[-1] == os.environ["CC_DRIVER_DIR"]
Path(os.environ["CC_STATE_DIR"]).mkdir(parents=True, exist_ok=True)
assert inp["provider"]["api_key"] == "sk-live-key", inp["provider"]
assert inp["protocol"] == 2 and isinstance(inp["first"], bool)
script = json.loads(script_path.read_text())
step = script.pop(0) if script else {"text": "done"}
script_path.write_text(json.dumps(script))

if step.get("crash"):
    print("boom", file=sys.stderr)
    sys.exit(7)
if step.get("no_output"):
    sys.exit(0)

provider = inp["provider"]["name"]
text = step.get("text")
calls = step.get("tool_calls") or []
if provider == "openai":
    output = [{"type": "reasoning", "id": "rs_1", "encrypted_content": "zzz"}]
    if text is not None:
        output.append({"type": "message", "role": "assistant",
                       "content": [{"type": "output_text", "text": text}]})
    for c in calls:
        output.append({"type": "function_call", "call_id": c["id"], "name": c["name"],
                       "arguments": json.dumps(c.get("args", {}))})
    response = {"id": "resp_1", "object": "response", "model": inp["target"]["model"], "output": output}
elif provider == "anthropic":
    content = [{"type": "thinking", "thinking": "hmm", "signature": "sig"}]
    if text is not None:
        content.append({"type": "text", "text": text})
    for c in calls:
        content.append({"type": "tool_use", "id": c["id"], "name": c["name"], "input": c.get("args", {})})
    response = {"id": "msg_1", "type": "message", "role": "assistant", "content": content,
                "stop_reason": "tool_use" if calls else "end_turn"}
else:
    parts = []
    if text is not None:
        parts.append({"text": text})
    for c in calls:
        parts.append({"functionCall": {"id": c["id"], "name": c["name"], "args": c.get("args", {})},
                      "thoughtSignature": "ts"})
    response = {"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}],
                "responseId": "r1"}

out = {
    "protocol": 2,
    "turn_id": inp["turn_id"],
    "response": response,
    "calls": step.get("calls", [{"provider": provider, "wire": {"openai": "responses", "anthropic": "anthropic", "gemini": "gemini"}[provider], "model": inp["target"]["model"], "usage": {"input": 100, "cached_input": 20, "output": 10, "reasoning_output": 3}}]),
    "driver": {"name": "test", "engine": "fake"},
}
if "context_payload" in step:
    out["context_payload"] = step["context_payload"]
if "state" in step:
    out["state"] = step["state"]
if step.get("wrong_turn_id"):
    out["turn_id"] = "999_zzzzzz"
Path(output_path).write_text(json.dumps(out))
print("turn", inp["turn_index"], "state", json.dumps(inp["state"]))
"""


@pytest.fixture
def workspace(tmp_path: Path) -> dict[str, Path]:
    """A two-package chain: an engine with run.sh and a leaf driver."""
    engine_dir = tmp_path / "engine"
    engine_dir.mkdir()
    (engine_dir / "fake_engine.py").write_text(FAKE_ENGINE)
    (engine_dir / "package.json").write_text(
        json.dumps(
            {"name": "@context-cup/engine-fake", "contextCup": {"kind": "engine"}}
        )
    )
    (engine_dir / "run.sh").write_text(
        f'exec "{sys.executable}" "$CC_SELF_DIR/fake_engine.py" "$1" "$2"\n'
    )
    (engine_dir / "setup.sh").write_text("echo engine setup\n")
    (engine_dir / "teardown.sh").write_text(
        'echo "engine teardown" > "$CC_STATE_DIR/engine_teardown"\n'
    )
    driver_dir = tmp_path / "driver"
    driver_dir.mkdir()
    (driver_dir / "package.json").write_text(
        json.dumps(
            {
                "name": "@context-cup-drivers/test_driver",
                "version": "0.0.1",
                "contextCup": {
                    "kind": "driver",
                    "extends": "@context-cup/engine-fake",
                    "config": {"k": 1},
                },
            }
        )
    )
    (driver_dir / "teardown.sh").write_text(
        'test ! -e "$CC_STATE_DIR/engine_teardown" && echo leaf > "$CC_STATE_DIR/leaf_teardown"\n'
    )
    (driver_dir / "node_modules").mkdir()
    (driver_dir / "node_modules" / "junk.js").write_text("")
    agent_dir = tmp_path / "agent"
    return {"engine": engine_dir, "driver": driver_dir, "agent": agent_dir}


def write_script(driver_dir: Path, steps: list[dict[str, Any]]) -> None:
    (driver_dir / "script.json").write_text(json.dumps(steps))


def make_settings(
    workspace: dict[str, Path], provider: str = "openai", **overrides: Any
) -> Settings:
    base: dict[str, Any] = {
        "trial_id": "task-1__abc123",
        "agent_dir": workspace["agent"],
        "chain": DriverChain.from_dirs([workspace["engine"], workspace["driver"]]),
        "target": Target(provider=provider, model="gpt-test", reasoning_effort="low"),
        "api_key": "sk-live-key",
        "turn_retries": 1,
        "max_steps": 10,
        "turn_timeout_sec": 30,
    }
    base.update(overrides)
    return Settings(**base)


class MemoryEnvironment:
    """Echoes tool calls back as results; a plain message ends the trial."""

    name = "memory"

    def __init__(
        self,
        *,
        tool_output: str = "ok",
        stop_on_message: str | None = "final_message",
        stop_tools: set[str] | None = None,
        opening: list[Utterance] | None = None,
    ):
        self.tool_output = tool_output
        self.stop_on_message = stop_on_message
        self.stop_tools = stop_tools or set()
        self.opening = opening or [Utterance("user", "task")]
        self.received: list[Any] = []
        self.closed_with: str | None = None

    async def open(self) -> EnvironmentStart:
        return EnvironmentStart(
            system="sys",
            opening=list(self.opening),
            tools=[
                {
                    "type": "function",
                    "function": {"name": "echo", "parameters": {"type": "object"}},
                }
            ],
            workspace_dir="/work",
        )

    async def on_tool_calls(
        self, tool_calls: list[ToolCallRef], text: str | None
    ) -> StepResult:
        self.received.append(tool_calls)
        results = [
            ToolResult(call.id, f"{self.tool_output}:{call.name}")
            for call in tool_calls
        ]
        stop = (
            "stop_tool" if any(c.name in self.stop_tools for c in tool_calls) else None
        )
        return StepResult(
            tool_results=results, stop_reason=stop, extra={"seen": len(self.received)}
        )

    async def on_message(self, text: str) -> StepResult:
        self.received.append(text)
        return StepResult(
            user_messages=["reply"] if self.stop_on_message is None else [],
            stop_reason=self.stop_on_message,
        )

    async def close(self, stop_reason: str) -> dict[str, Any]:
        self.closed_with = stop_reason
        return {"closed": True}
