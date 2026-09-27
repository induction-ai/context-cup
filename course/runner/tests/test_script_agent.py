"""A script agent's agent.sh, run in place of the turn loop: what it is
handed, and the summary and trajectory made from what it hands back."""

from __future__ import annotations

import json
from pathlib import Path

from context_cup_runner.script_agent import run

AGENT = """#!/usr/bin/env bash
set -euo pipefail
echo "$CC_INSTRUCTION_FILE|$OPENAI_BASE_URL|$OPENAI_API_KEY|$CC_MAX_STEPS" > "$CC_AGENT_DIR/seen.txt"
echo "${CC_SYSTEM_PROMPT:-none}" > "$CC_AGENT_DIR/system.txt"
echo "$CC_CONFIG" > "$CC_AGENT_DIR/config.txt"
cat > "$CC_RESULT_FILE" <<'JSON'
{"stop_reason": "agent_done", "turns": 1, "env_tool_calls": 0,
 "payload": {"model": "gpt-5.5", "input": [
   {"role": "user", "content": "task"},
   {"type": "message", "role": "assistant",
    "content": [{"type": "output_text", "text": "done"}]}]}}
JSON
exit "${AGENT_EXIT:-0}"
"""


def setup(tmp_path: Path) -> dict[str, str]:
    package = tmp_path / "base_agent"
    package.mkdir()
    (package / "pyproject.toml").write_text(
        '[project]\nname = "base-agent"\n'
        '[tool.context-cup]\nkind = "agent"\n'
        "[tool.context-cup.config]\nmax_bytes = 10\n"
    )
    (package / "agent.sh").write_text(AGENT)
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    return {
        "PATH": "/usr/bin:/bin",
        "CC_AGENT_DIR": str(agent_dir),
        "CC_TRIAL_ID": "trial-1",
        "CC_DRIVER_CHAIN": str(package),
        "CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "gpt-5.5"}),
        "CC_PROXY_URL": "http://127.0.0.1:18080",
        "CC_INSTRUCTION_FILE": "/i.md",
        "CC_MAX_STEPS": "200",
    }


def test_the_agent_gets_the_task_and_the_proxy_and_its_result_is_kept(
    tmp_path, monkeypatch
):
    env = setup(tmp_path)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert run(env) == 0
    agent_dir = tmp_path / "agent"
    assert (agent_dir / "seen.txt").read_text().strip() == (
        "/i.md|http://127.0.0.1:18080/t/trial-1/openai/v1|cc-proxy|200"
    )
    summary = json.loads((agent_dir / "summary.json").read_text())
    assert summary["stop_reason"] == "agent_done"
    assert (summary["turns"], summary["env_tool_calls"], summary["errors"]) == (
        1,
        0,
        [],
    )
    assert summary["driver"]["name"] == "base_agent"
    assert json.loads((agent_dir / "config.txt").read_text()) == {"max_bytes": 10}
    trajectory = json.loads((agent_dir / "trajectory.json").read_text())
    assert [s["source"] for s in trajectory["steps"]] == ["user", "agent"]


def test_a_failing_agent_fails_the_trial(tmp_path, monkeypatch):
    env = {**setup(tmp_path), "AGENT_EXIT": "3"}
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert run(env) == 3
    summary = json.loads((tmp_path / "agent" / "summary.json").read_text())
    assert summary["errors"] == [{"error": "agent.sh exited with 3"}]
    assert summary["stop_reason"] == "agent_error"


def test_a_toolathlon_agent_gets_the_task_bundle_s_agent_prompt(tmp_path, monkeypatch):
    bundle = tmp_path / "task_bundle.json"
    bundle.write_text(
        json.dumps({"system_prompts": {"agent": "Accessible workspace: /w"}})
    )
    env = {
        **setup(tmp_path),
        "CC_BENCHMARK": "toolathlon",
        "CC_TOOLATHLON_BUNDLE": str(bundle),
    }
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert run(env) == 0
    assert (tmp_path / "agent" / "system.txt").read_text().strip() == (
        "Accessible workspace: /w"
    )
