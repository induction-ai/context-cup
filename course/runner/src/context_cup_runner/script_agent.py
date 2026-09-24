"""Runs a whole agent's `agent.sh` inside the trial container, in place of
the turn loop (the script agents in agent.py). Started as
`python -m context_cup_runner.script_agent`.

First the benchmark is set up as the turn loop's environment would set it
up, so an agent faces the same task a turn-protocol driver does: tau3's
runtime is configured with the trial's seed and caps (the agent starts the
conversation itself), and Toolathlon's agent prompt (the workspace
directory, how to finish) is read from the task bundle for the agent.

agent.sh runs once, as `ccdriver`, from its package directory, with the
script variables every driver script gets (CC_DRIVER_DIR, CC_SELF_DIR,
CC_CHAIN, CC_STATE_DIR, CC_TRIAL_ID, CC_NODE), the proxy's base URLs and
placeholder keys, and:

  CC_INSTRUCTION_FILE   harbor's instruction for the task
  CC_MCP_SERVERS_JSON   the task's MCP servers: [{name, transport, url,
                        command, args}], the tools the agent works with
  CC_TARGET_JSON        {provider, model, reasoning_effort}
  CC_MAX_STEPS          the course's step cap for the benchmark
  CC_AGENT_DIR          the trial's agent log directory
  CC_RESULT_FILE        where the agent may write its result (below)
  CC_SYSTEM_PROMPT      the benchmark's system prompt for the agent, when it
                        has one outside the instruction (Toolathlon's)
  CC_HARNESS_TOOLS      comma-separated MCP tools the harness owns (tau3's
                        runtime controls): listed by the server, not for the
                        model; calling one undoes the trial's setup

The agent works the task and exits; a non-zero exit fails the trial. Its
output goes to the trial's runner.txt. What it writes to CC_RESULT_FILE, all
optional: `stop_reason`, `turns` (model calls that were steps of the task),
`env_tool_calls`, and `payload`, its conversation as the provider's native
request body, from which this module builds trajectory.json the way the
turn loop does.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from context_cup_protocol import adapter_for

from . import __version__
from .atif import build_trajectory
from .chain import DriverChain, RunAs
from .protocol import Target, proxy_env

RESULT_FILE = "agent_result.json"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _read_result(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        if path.exists():
            print(f"[runner] could not read {path}: {exc}", flush=True)
        return {}
    return value if isinstance(value, dict) else {}


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def benchmark_setup(env: dict[str, str], agent_dir: Path) -> dict[str, str]:
    """Set the task up as the turn loop would, and return what agent.sh
    should get for it."""
    benchmark = env.get("CC_BENCHMARK")
    if benchmark == "tau3":
        from .envs.tau3 import HARNESS_TOOL_NAMES, Tau3Environment

        asyncio.run(
            Tau3Environment.from_env(env, agent_dir=agent_dir).configure_for_agent()
        )
        print("[runner] tau3 runtime configured for the trial", flush=True)
        return {"CC_HARNESS_TOOLS": ",".join(sorted(HARNESS_TOOL_NAMES))}
    elif benchmark == "toolathlon":
        from .envs.toolathlon import DEFAULT_BUNDLE, bundle_system_prompt, read_bundle

        bundle = read_bundle(Path(env.get("CC_TOOLATHLON_BUNDLE") or DEFAULT_BUNDLE))
        prompt = bundle_system_prompt(bundle)
        if prompt:
            return {"CC_SYSTEM_PROMPT": prompt}
        print("[runner] the task bundle has no agent prompt", flush=True)
    return {}


def run(env: dict[str, str]) -> int:
    agent_dir = Path(env.get("CC_AGENT_DIR") or "/logs/agent")
    trial_id = env["CC_TRIAL_ID"]
    chain = DriverChain.from_env_value(env["CC_DRIVER_CHAIN"])
    package = chain.leaf
    script = package.script("agent.sh")
    if script is None:
        print(f"[runner] {package.name} has no agent.sh", file=sys.stderr, flush=True)
        return 2
    target = Target.model_validate(json.loads(env["CC_TARGET_JSON"]))
    run_as = RunAs.from_env(env)
    result_file = agent_dir / RESULT_FILE
    result_file.unlink(missing_ok=True)
    setup = benchmark_setup(env, agent_dir)
    script_env = chain.script_env(
        package,
        trial_id=trial_id,
        state_dir=agent_dir / "driver_state",
        extra={
            **proxy_env(env.get("CC_PROXY_URL") or "http://127.0.0.1:18080", trial_id),
            "CC_AGENT_DIR": str(agent_dir),
            "CC_RESULT_FILE": str(result_file),
            **setup,
        },
    )
    argv = ["bash", str(script)]
    if run_as is not None:
        argv, script_env = run_as.wrap(argv), run_as.env(script_env)
        print(f"[runner] agent.sh runs as {run_as.describe()}", flush=True)
    print(
        f"[runner] trial {trial_id}: agent {package.name} / "
        f"{target.provider}:{target.model}",
        flush=True,
    )
    started_at = _now()
    returncode = subprocess.run(
        argv, cwd=package.dir, env=script_env, check=False
    ).returncode

    result = _read_result(result_file)
    stop_reason = result.get("stop_reason")
    if returncode != 0:
        stop_reason = "agent_error"
    elif not isinstance(stop_reason, str) or not stop_reason:
        stop_reason = "agent_exit"
    errors = (
        [] if returncode == 0 else [{"error": f"agent.sh exited with {returncode}"}]
    )
    summary = {
        "stop_reason": stop_reason,
        "turns": _int(result.get("turns")),
        "env_tool_calls": _int(result.get("env_tool_calls")),
        "errors": errors,
        "driver": chain.info(),
        "provider": target.provider,
        "target": target.model_dump(mode="json"),
        "started_at": started_at,
        "finished_at": _now(),
    }
    (agent_dir / "summary.json").write_text(
        json.dumps({k: v for k, v in summary.items() if v is not None}, indent=2)
    )
    payload = result.get("payload")
    if isinstance(payload, dict):
        try:
            trajectory = build_trajectory(
                trial_id=trial_id,
                steps=adapter_for(target.provider).steps_from_payload(payload),
                turns=[],
                target=target,
                tools=list(result.get("tools") or []),
                runner_version=__version__,
                driver=chain.info(),
            )
        except Exception as exc:  # noqa: BLE001 - the trial's result stands
            print(f"[runner] no trajectory from the agent's payload: {exc}", flush=True)
        else:
            if trajectory["steps"]:
                (agent_dir / "trajectory.json").write_text(
                    json.dumps(trajectory, indent=2)
                )
    print(
        f"[runner] agent done: exit={returncode} stop_reason={stop_reason}",
        flush=True,
    )
    return returncode


def main() -> None:
    sys.exit(run(dict(os.environ)))


if __name__ == "__main__":
    main()
