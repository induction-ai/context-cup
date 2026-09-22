"""The in-container loop: owns both payloads and drives one trial turn by turn.

    python -m context_cup_runner.loop

Settings arrive as CC_* environment variables (see README.md). The loop
writes turns/, usage.json, trajectory.json, summary.json, and the final
original_payload.json and context_payload.json under CC_AGENT_DIR, which
harbor copies out of the container.
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
import traceback
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import __version__
from .atif import TurnRecord, build_trajectory
from .chain import DriverChain, run_script, run_turn_script
from .clipping import clip_tool_output
from .environment import Environment, StepResult
from .protocol import (
    PROVIDER_CLIENTS,
    PROVIDER_KEY_VARS,
    REDACTED,
    Dirs,
    ProviderInfo,
    Target,
    TargetSpec,
    TurnInput,
    TurnOutput,
    Usage,
    new_turn_id,
    validate_output,
)
from .providers import Extracted, Payload, ProviderAdapter, ToolCallRef, adapter_for

DEFAULT_TURN_RETRIES = 2
DEFAULT_MAX_STEPS = 200
DEFAULT_MAX_TOOL_OUTPUT_CHARS = 100_000
DEFAULT_TURN_TIMEOUT_SEC = 1800.0


class TrialError(RuntimeError):
    """The trial cannot continue; harbor records the message."""


def api_key_from_env(provider: str, env: dict[str, str]) -> str:
    for name in PROVIDER_KEY_VARS.get(provider, ()):  # type: ignore[call-overload]
        value = env.get(name)
        if value:
            return value
    return ""


@dataclass
class Settings:
    trial_id: str
    agent_dir: Path
    chain: DriverChain
    target: Target
    api_key: str = ""
    turn_retries: int = DEFAULT_TURN_RETRIES
    max_steps: int = DEFAULT_MAX_STEPS
    max_tool_output_chars: int = DEFAULT_MAX_TOOL_OUTPUT_CHARS
    turn_timeout_sec: float | None = DEFAULT_TURN_TIMEOUT_SEC

    @classmethod
    def from_env(
        cls, env: dict[str, str], *, default_max_steps: int = DEFAULT_MAX_STEPS
    ) -> Settings:
        def need(key: str) -> str:
            value = env.get(key)
            if not value:
                raise TrialError(f"{key} is required")
            return value

        target = Target.model_validate(json.loads(need("CC_TARGET_JSON")))
        return cls(
            trial_id=need("CC_TRIAL_ID"),
            agent_dir=Path(env.get("CC_AGENT_DIR") or "/logs/agent"),
            chain=DriverChain.from_env_value(need("CC_DRIVER_CHAIN")),
            target=target,
            api_key=api_key_from_env(target.provider, env),
            turn_retries=int(env.get("CC_TURN_RETRIES") or DEFAULT_TURN_RETRIES),
            max_steps=int(env.get("CC_MAX_STEPS") or default_max_steps),
            max_tool_output_chars=int(
                env.get("CC_MAX_TOOL_OUTPUT_CHARS") or DEFAULT_MAX_TOOL_OUTPUT_CHARS
            ),
            turn_timeout_sec=float(
                env.get("CC_TURN_TIMEOUT_SEC") or DEFAULT_TURN_TIMEOUT_SEC
            ),
        )

    def provider_info(self) -> ProviderInfo:
        return ProviderInfo(
            name=self.target.provider,
            api_key=self.api_key,
            client=PROVIDER_CLIENTS[self.target.provider],
        )


@dataclass
class TrialResult:
    stop_reason: str
    turns: int
    env_tool_calls: int
    usage: Usage
    calls: list[dict[str, Any]]
    errors: list[dict[str, Any]] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


class Trial:
    def __init__(self, settings: Settings, environment: Environment):
        self.settings = settings
        self.environment = environment
        self.chain = settings.chain
        self.adapter: ProviderAdapter = adapter_for(settings.target.provider)
        self.original: Payload = {}
        self.context: Payload = {}
        self.state: Any = {}
        self.tools: list[dict[str, Any]] = []
        self.workspace_dir: str | None = None
        self.turn_records: list[TurnRecord] = []
        self.calls: list[dict[str, Any]] = []
        self.totals = Usage()
        self.errors: list[dict[str, Any]] = []
        self.turn_counter = 0
        self.env_tool_calls = 0
        self.started_at = _now()

    @property
    def agent_dir(self) -> Path:
        return self.settings.agent_dir

    @property
    def state_dir(self) -> Path:
        return self.agent_dir / "driver_state"

    def driver_info(self) -> dict[str, Any]:
        return self.chain.info()

    # -- one turn ---------------------------------------------------------

    def _next_turn_dir(self) -> tuple[str, Path]:
        self.turn_counter += 1
        turn_id = new_turn_id(self.turn_counter)
        turn_dir = self.agent_dir / "turns" / turn_id
        turn_dir.mkdir(parents=True, exist_ok=False)
        return turn_id, turn_dir

    def _turn_input(self, turn_id: str, turn_dir: Path, turn_index: int) -> TurnInput:
        target = self.settings.target
        return TurnInput(
            trial_id=self.settings.trial_id,
            turn_id=turn_id,
            turn_index=turn_index,
            first=turn_index == 1,
            provider=self.settings.provider_info(),
            target=TargetSpec(
                model=target.model, reasoning_effort=target.reasoning_effort
            ),
            context_payload=self.context,
            original_payload=self.original,
            state=self.state,
            limits={"max_steps": self.settings.max_steps},
            dirs=Dirs(
                turn=str(turn_dir),
                state=str(self.state_dir),
                workspace=self.workspace_dir,
            ),
        )

    @staticmethod
    def _write_input(turn_dir: Path, payload: TurnInput) -> None:
        (turn_dir / "input.json").write_text(
            payload.model_dump_json(exclude_none=True, indent=2), encoding="utf-8"
        )

    @staticmethod
    def _redact_input(turn_dir: Path, payload: TurnInput) -> None:
        """The turn directory is copied out as an artifact: once the driver
        has run, the persisted input.json must not carry the key."""
        redacted = payload.model_copy(deep=True)
        redacted.provider.api_key = REDACTED
        Trial._write_input(turn_dir, redacted)

    def _run_once(
        self, turn_index: int
    ) -> tuple[str, TurnOutput | None, Extracted | None, str | None]:
        turn_id, turn_dir = self._next_turn_dir()
        payload = self._turn_input(turn_id, turn_dir, turn_index)
        self._write_input(turn_dir, payload)
        try:
            run = run_turn_script(
                self.chain,
                turn_dir,
                trial_id=self.settings.trial_id,
                state_dir=self.state_dir,
                timeout_sec=self.settings.turn_timeout_sec,
            )
        finally:
            self._redact_input(turn_dir, payload)
        if run.returncode != 0:
            tail = run.stderr.strip().splitlines()[-5:]
            return (
                turn_id,
                None,
                None,
                f"driver exited {run.returncode}: " + " | ".join(tail),
            )
        output_path = turn_dir / "output.json"
        if not output_path.exists():
            return turn_id, None, None, "driver wrote no output.json"
        try:
            output, extracted = validate_output(
                json.loads(output_path.read_text(encoding="utf-8")),
                turn_id,
                self.adapter,
            )
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            return turn_id, None, None, f"invalid output.json: {exc}"
        return turn_id, output, extracted, None

    def run_turn(self, turn_index: int) -> tuple[TurnOutput, Extracted]:
        attempts = self.settings.turn_retries + 1
        last_error = "unknown"
        for attempt in range(attempts):
            turn_id, output, extracted, error = self._run_once(turn_index)
            if output is not None and extracted is not None:
                return output, extracted
            last_error = error or "unknown"
            self.errors.append(
                {
                    "turn_id": turn_id,
                    "turn_index": turn_index,
                    "attempt": attempt + 1,
                    "error": last_error,
                }
            )
            print(
                f"[runner] turn {turn_id} failed ({attempt + 1}/{attempts}): {last_error}",
                flush=True,
            )
        raise TrialError(
            f"turn {turn_index} failed after {attempts} attempts: {last_error}"
        )

    def _record(self, output: TurnOutput) -> None:
        """Take the driver's response into both payloads, and its state and
        working copy into the next turn."""
        if output.context_payload is not None:
            self.context = copy.deepcopy(output.context_payload)
        if output.state_given:
            self.state = output.state
        self.adapter.append_response(self.original, output.response)
        self.adapter.append_response(self.context, copy.deepcopy(output.response))
        self.turn_records.append(TurnRecord(output.turn_id, output.calls))
        for call in output.calls:
            self.totals.add(call.usage)
            entry = call.model_dump(mode="json")
            entry["turn_id"] = output.turn_id
            self.calls.append(entry)

    # -- the loop ---------------------------------------------------------

    async def _apply(self, extracted: Extracted) -> StepResult:
        if extracted.tool_calls:
            self.env_tool_calls += len(extracted.tool_calls)
            result = await self.environment.on_tool_calls(
                extracted.tool_calls, extracted.text
            )
            by_id = {call.id: call for call in extracted.tool_calls}
            pairs: list[tuple[ToolCallRef, str]] = []
            for tool_result in result.tool_results:
                call = by_id.get(tool_result.tool_call_id)
                if call is None:
                    print(
                        f"[runner] result for unknown call {tool_result.tool_call_id!r} dropped",
                        flush=True,
                    )
                    continue
                clipped = clip_tool_output(
                    tool_result.content,
                    max_chars=self.settings.max_tool_output_chars,
                    agent_dir=self.agent_dir,
                    tool_call_id=tool_result.tool_call_id,
                )
                pairs.append((call, clipped))
            self.adapter.append_tool_results(self.original, pairs)
            self.adapter.append_tool_results(self.context, pairs)
        else:
            result = await self.environment.on_message(extracted.text or "")
        for text in result.user_messages:
            self.adapter.append_user(self.original, text)
            self.adapter.append_user(self.context, text)
        return result

    async def run(self) -> TrialResult:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        start = await self.environment.open()
        self.tools = list(start.tools)
        self.workspace_dir = start.workspace_dir
        self.original = self.adapter.initial_payload(
            model=self.settings.target.model,
            system=start.system,
            opening=start.opening,
            tools=self.tools,
            reasoning_effort=self.settings.target.reasoning_effort,
        )
        self.context = copy.deepcopy(self.original)
        stop_reason = start.stop_reason or "max_steps"
        extra: dict[str, Any] = {}
        turns = 0
        try:
            if start.stop_reason is None:
                for turn_index in range(1, self.settings.max_steps + 1):
                    output, extracted = self.run_turn(turn_index)
                    self._record(output)
                    turns = turn_index
                    result = await self._apply(extracted)
                    extra.update(result.extra)
                    if result.stop_reason:
                        stop_reason = result.stop_reason
                        break
        except TrialError as exc:
            stop_reason = "runner_error"
            extra["error"] = str(exc)
            raise
        finally:
            try:
                extra.update(await self.environment.close(stop_reason))
            except Exception as exc:  # noqa: BLE001 - teardown must not hide the result
                extra["close_error"] = f"{type(exc).__name__}: {exc}"
            teardown_errors = self.run_teardowns()
            if teardown_errors:
                extra["teardown_errors"] = teardown_errors
            self.write_artifacts(stop_reason, turns, extra)
        return TrialResult(
            stop_reason,
            turns,
            self.env_tool_calls,
            self.totals,
            self.calls,
            self.errors,
            extra,
        )

    def run_teardowns(self) -> list[dict[str, Any]]:
        """Every teardown.sh in the chain, leaf first. Failures are recorded,
        not raised: the trial's result stands."""
        errors = []
        for package, script in self.chain.teardown_scripts():
            env = self.chain.script_env(
                package, trial_id=self.settings.trial_id, state_dir=self.state_dir
            )
            run = run_script(
                script,
                [],
                cwd=package.dir,
                env=env,
                timeout_sec=self.settings.turn_timeout_sec,
            )
            log_dir = self.agent_dir / "scripts"
            log_dir.mkdir(parents=True, exist_ok=True)
            (log_dir / f"teardown_{package.name}.txt").write_text(
                run.stdout + run.stderr, encoding="utf-8"
            )
            if run.returncode != 0:
                errors.append({"package": package.name, "returncode": run.returncode})
        return errors

    # -- artifacts --------------------------------------------------------

    def write_artifacts(
        self, stop_reason: str, turns: int, extra: dict[str, Any]
    ) -> None:
        _write_json(
            self.agent_dir / "usage.json",
            {"calls": self.calls, "totals": self.totals.model_dump()},
        )
        _write_json(self.agent_dir / "original_payload.json", self.original)
        _write_json(self.agent_dir / "context_payload.json", self.context)
        trajectory = build_trajectory(
            trial_id=self.settings.trial_id,
            steps=self.adapter.steps_from_payload(self.original),
            turns=self.turn_records,
            target=self.settings.target,
            tools=self.tools,
            totals=self.totals,
            runner_version=__version__,
            driver=self.driver_info(),
        )
        if trajectory["steps"]:
            _write_json(self.agent_dir / "trajectory.json", trajectory)
        _write_json(
            self.agent_dir / "summary.json",
            {
                "stop_reason": stop_reason,
                "turns": turns,
                "env_tool_calls": self.env_tool_calls,
                "errors": self.errors,
                "driver": self.driver_info(),
                "provider": self.settings.target.provider,
                "target": self.settings.target.model_dump(mode="json"),
                "benchmark": self.environment.name,
                "usage": self.totals.model_dump(),
                "started_at": self.started_at,
                "finished_at": _now(),
                "extra": extra,
            },
        )


def build_environment(
    benchmark: str, env: dict[str, str], settings: Settings
) -> Environment:
    if benchmark == "tau3":
        from .envs.tau3 import Tau3Environment

        return Tau3Environment.from_env(env)
    if benchmark == "toolathlon":
        from .envs.toolathlon import ToolathlonEnvironment

        return ToolathlonEnvironment.from_env(env, agent_dir=settings.agent_dir)
    raise TrialError(f"unknown CC_BENCHMARK {benchmark!r}")


def default_max_steps(benchmark: str) -> int:
    return {"tau3": 200, "toolathlon": 150}.get(benchmark, DEFAULT_MAX_STEPS)


async def async_main(env: dict[str, str]) -> int:
    benchmark = env.get("CC_BENCHMARK") or ""
    settings = Settings.from_env(env, default_max_steps=default_max_steps(benchmark))
    settings.agent_dir.mkdir(parents=True, exist_ok=True)
    environment = build_environment(benchmark, env, settings)
    trial = Trial(settings, environment)
    print(
        f"[runner] trial {settings.trial_id}: {benchmark} / {trial.chain.leaf.name} / "
        f"{settings.target.provider}:{settings.target.model}",
        flush=True,
    )
    if not settings.api_key:
        print(
            f"[runner] no API key for {settings.target.provider} in the environment",
            flush=True,
        )
    try:
        result = await trial.run()
    except TrialError as exc:
        print(f"[runner] trial failed: {exc}", file=sys.stderr, flush=True)
        return 2
    except Exception:  # noqa: BLE001 - the traceback is the useful part
        traceback.print_exc()
        return 3
    print(
        f"[runner] done: stop_reason={result.stop_reason} turns={result.turns} "
        f"tokens in/out={result.usage.input}/{result.usage.output}",
        flush=True,
    )
    return 0


def main() -> None:
    sys.exit(asyncio.run(async_main(dict(os.environ))))


if __name__ == "__main__":
    main()
