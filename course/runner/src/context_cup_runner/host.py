"""Host-side harbor agent base: runs inside harbor's process, uploads the
runner, engine and driver into the trial container, execs the loop there,
and reads the artifacts back into harbor's AgentContext.

Selected on the harbor command line as
  --agent context_cup_runner.tau3:Tau3Agent
  --agent context_cup_runner.toolathlon:ToolathlonAgent
with PYTHONPATH pointing at course/runner/src.
"""

from __future__ import annotations

import json
import shlex
import shutil
from pathlib import Path
from typing import Any

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from . import __version__
from .chain import DriverChain
from .uv_bootstrap import cached_uv_binary, uv_target_triple

INSTALL_ROOT = "/installed-agent"
AGENT_DIR = "/logs/agent"
REMOTE_PACKAGE = f"{INSTALL_ROOT}/context_cup_runner"
REMOTE_CHAIN = f"{INSTALL_ROOT}/chain"
REMOTE_STATE = f"{AGENT_DIR}/driver_state"
REMOTE_INSTRUCTION = f"{INSTALL_ROOT}/instruction.md"

IN_CONTAINER_DEPS = ["pydantic>=2", "mcp>=1.25,<2"]

# One uv-managed Python 3.12 per container, shared by the runner loop and every
# engine setup.sh (they find `uv` on PATH and reuse the same interpreter store).
# The task image's own Python is never used.
PYTHON_VERSION = "3.12"
UV_DIR = f"{INSTALL_ROOT}/.uv"
UV_BIN = f"{UV_DIR}/uv"
RUNNER_VENV = f"{INSTALL_ROOT}/.venv"
RUNNER_PYTHON = f"{RUNNER_VENV}/bin/python"
UV_ENV = {
    "UV_CACHE_DIR": f"{UV_DIR}/cache",
    "UV_PYTHON_INSTALL_DIR": f"{UV_DIR}/python",
    "UV_NO_MODIFY_PATH": "1",
}

UPLOAD_IGNORE = (
    "node_modules",
    ".git",
    "__pycache__",
    ".venv",
    ".uv",
    "dist",
    ".pytest_cache",
    ".ruff_cache",
    "*.pyc",
)

PROVIDER_KEYS = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY",
)

# Settings the suite passes with --agent-env and the loop reads as-is.
PASSTHROUGH_SETTINGS = (
    "CC_TARGET_JSON",
    "CC_TURN_RETRIES",
    "CC_MAX_STEPS",
    "CC_MAX_TOOL_OUTPUT_CHARS",
    "CC_TURN_TIMEOUT_SEC",
    "CC_TOOL_TIMEOUT_SEC",
)


class CourseAgent(BaseInstalledAgent):
    """Shared upload, install, exec and read-back. Subclasses name the
    benchmark and add its environment settings."""

    benchmark: str = ""

    capabilities = AgentCapabilities(atif=True, mcp_servers=True)

    @staticmethod
    def name() -> str:
        return "context-cup-runner"

    def version(self) -> str | None:
        return self._version or __version__

    # -- setup ------------------------------------------------------------

    def host_chain(self) -> DriverChain:
        value = self._get_env("CC_HOST_DRIVER_CHAIN")
        if not value:
            raise ValueError("CC_HOST_DRIVER_CHAIN is required")
        chain = DriverChain.from_env_value(value)
        for package in chain.packages:
            if not package.dir.is_dir():
                raise ValueError(
                    f"CC_HOST_DRIVER_CHAIN entry {package.dir} is not a directory"
                )
        return chain

    def remote_chain_dirs(self, chain: DriverChain) -> list[str]:
        """Where each package lands in the container: indexed so order is
        visible and two packages with one basename cannot collide."""
        return [
            f"{REMOTE_CHAIN}/{i:02d}_{p.dir.name}" for i, p in enumerate(chain.packages)
        ]

    def remote_chain_value(self, chain: DriverChain) -> str:
        return ":".join(self.remote_chain_dirs(chain))

    def script_env(self, chain: DriverChain, index: int) -> dict[str, str]:
        dirs = self.remote_chain_dirs(chain)
        env = {
            "CC_DRIVER_DIR": dirs[-1],
            "CC_SELF_DIR": dirs[index],
            "CC_CHAIN": ":".join(dirs),
            "CC_STATE_DIR": REMOTE_STATE,
            "CC_TRIAL_ID": self.trial_id(),
        }
        env.update(UV_ENV)
        env["CC_PYTHON"] = RUNNER_PYTHON
        env["PATH"] = (
            f"{UV_DIR}:{RUNNER_VENV}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        )
        return env

    def trial_id(self) -> str:
        return str(self.logs_dir.parent.name)

    def stage_package(self, package_dir: Path, index: int) -> Path:
        """A copy without host-only clutter (node_modules and friends), so the
        upload carries the scripts and sources, not a pnpm tree."""
        staged = (
            Path(self.logs_dir) / "setup" / "chain" / f"{index:02d}_{package_dir.name}"
        )
        if staged.exists():
            shutil.rmtree(staged)
        shutil.copytree(
            package_dir,
            staged,
            ignore=shutil.ignore_patterns(*UPLOAD_IGNORE),
            symlinks=False,
        )
        return staged

    async def install(self, environment: BaseEnvironment) -> None:
        chain = self.host_chain()
        # The upload target's parent must exist, or harbor's `docker compose cp`
        # fails and falls back to a tar stream whose directories the agent user
        # cannot traverse.
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {REMOTE_CHAIN} {AGENT_DIR} && chmod a+rwx {AGENT_DIR}",
        )
        await environment.upload_dir(Path(__file__).parent, REMOTE_PACKAGE)
        for index, (package, remote) in enumerate(
            zip(chain.packages, self.remote_chain_dirs(chain), strict=True)
        ):
            await environment.upload_dir(self.stage_package(package.dir, index), remote)
        await self._open_install_root(environment)

        await self._upload_uv(environment)
        deps = " ".join(shlex.quote(d) for d in IN_CONTAINER_DEPS)
        await self.exec_as_root(
            environment,
            command=(
                f"{UV_BIN} venv --quiet --python {PYTHON_VERSION} {RUNNER_VENV} && "
                f"{UV_BIN} pip install --quiet --python {RUNNER_PYTHON} {deps} && "
                f"mkdir -p {REMOTE_STATE} && chmod 777 {REMOTE_STATE}"
            ),
            env=UV_ENV,
            timeout_sec=900,
        )
        # Every setup.sh, root first, from its own directory.
        for index, (package, remote) in enumerate(
            zip(chain.packages, self.remote_chain_dirs(chain), strict=True)
        ):
            if package.script("setup.sh") is None:
                continue
            await self.exec_as_root(
                environment,
                command=f"cd {shlex.quote(remote)} && bash setup.sh 2>&1 | tee {AGENT_DIR}/setup_{package.name}.txt",
                env=self.script_env(chain, index),
                timeout_sec=900,
            )
        # setup.sh runs as root; run.sh runs as the agent user and must be able
        # to read and execute everything setup left behind (venvs included).
        await self._open_install_root(environment)

    async def _upload_uv(self, environment: BaseEnvironment) -> None:
        """Put the pinned uv release at UV_BIN, built for the container."""
        probe = await self.exec_as_root(
            environment,
            command="uname -m; (ls /lib/ld-musl-* >/dev/null 2>&1 && echo musl) || echo gnu",
        )
        lines = [ln.strip() for ln in (probe.stdout or "").splitlines() if ln.strip()]
        if len(lines) < 2:
            raise RuntimeError(
                f"could not probe the container architecture: {probe.stdout!r}"
            )
        binary = cached_uv_binary(uv_target_triple(lines[0], lines[1]))
        await self.exec_as_root(environment, command=f"mkdir -p {UV_DIR}")
        await environment.upload_file(binary, UV_BIN)
        await self.exec_as_root(environment, command=f"chmod 755 {UV_BIN}")

    async def _open_install_root(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {REMOTE_STATE} && chmod -R a+rX {INSTALL_ROOT} "
                f"&& chmod -R a+rwx {REMOTE_STATE}"
            ),
        )

    # -- run --------------------------------------------------------------

    def environment_settings(self, environment: BaseEnvironment) -> dict[str, str]:
        """Benchmark-specific CC_* settings. Subclasses override."""
        return {}

    def _loop_env(self, environment: BaseEnvironment) -> dict[str, str]:
        env: dict[str, str] = {
            "PYTHONPATH": INSTALL_ROOT,
            "PYTHONUNBUFFERED": "1",
            "CC_BENCHMARK": self.benchmark,
            "CC_TRIAL_ID": self.trial_id(),
            "CC_AGENT_DIR": AGENT_DIR,
            "CC_DRIVER_CHAIN": self.remote_chain_value(self.host_chain()),
            "CC_INSTRUCTION_FILE": REMOTE_INSTRUCTION,
        }
        for key in (*PROVIDER_KEYS, *PASSTHROUGH_SETTINGS):
            value = self._get_env(key)
            if value:
                env[key] = value
        if "CC_TARGET_JSON" not in env:
            raise ValueError("CC_TARGET_JSON is required")
        env.update(self.environment_settings(environment))
        return env

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        local_instruction = self.logs_dir / "instruction.md"
        local_instruction.parent.mkdir(parents=True, exist_ok=True)
        local_instruction.write_text(instruction, encoding="utf-8")
        await environment.upload_file(local_instruction, REMOTE_INSTRUCTION)

        env = self._loop_env(environment)
        await self.exec_as_agent(
            environment, command=f"mkdir -p {AGENT_DIR} {REMOTE_STATE}"
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"cd {INSTALL_ROOT} && {RUNNER_PYTHON} -m context_cup_runner.loop "
                f"2>&1 </dev/null | tee {AGENT_DIR}/runner.txt"
            ),
            env=env,
            timeout_sec=None,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        usage = _read_json(self.logs_dir / "usage.json")
        totals = usage.get("totals") if isinstance(usage, dict) else None
        if isinstance(totals, dict):
            context.n_input_tokens = _int(totals.get("input"))
            context.n_cache_tokens = _int(totals.get("cached_input"))
            context.n_output_tokens = _int(totals.get("output"))
        summary = _read_json(self.logs_dir / "summary.json")
        if isinstance(summary, dict):
            context.metadata = {
                key: summary.get(key)
                for key in (
                    "stop_reason",
                    "turns",
                    "env_tool_calls",
                    "driver",
                    "benchmark",
                    "extra",
                )
            }

    def mcp_servers_json(self) -> str:
        return json.dumps(
            [
                {
                    "name": server.name,
                    "transport": server.transport,
                    "url": getattr(server, "url", None),
                    "command": getattr(server, "command", None),
                    "args": list(getattr(server, "args", None) or []),
                }
                for server in self.mcp_servers
            ]
        )


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
