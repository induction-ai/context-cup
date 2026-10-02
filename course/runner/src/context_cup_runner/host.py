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
from .container import (
    AGENT_DIR,
    DRIVER_USER,
    INSTALL_ROOT,
    NODE_BIN,
    PROXY_URL,
    check_isolation,
    create_driver_user,
    probe_platform,
    start_proxy,
    stop_proxy,
    upload_node,
    wait_for_proxy,
)
from .pins import (
    WORKSPACE,
    check_python_root,
    declares_dependencies,
    engine_chain,
    package_pins,
    without_pinned,
    workspace_pins,
)
from .uv_bootstrap import cached_uv_binary, uv_target_triple

REMOTE_PACKAGE = f"{INSTALL_ROOT}/context_cup_runner"
# The shared protocol library (course/protocol), installed into the runner's
# venv here and into engine venvs by their setup.sh via CC_PROTOCOL_DIR.
REMOTE_PROTOCOL = f"{INSTALL_ROOT}/protocol"
PROTOCOL_DIR = WORKSPACE / "course" / "protocol"
REMOTE_CHAIN = f"{INSTALL_ROOT}/chain"
REMOTE_STATE = f"{AGENT_DIR}/driver_state"
REMOTE_INSTRUCTION = f"{INSTALL_ROOT}/instruction.md"
# Versions exported from the uv.lock files on the host (pins.py), read by the
# container's uv as constraints: the workspace's, and one per package that
# declares its own dependencies.
REMOTE_PINS = f"{INSTALL_ROOT}/pins"
WORKSPACE_PINS = f"{REMOTE_PINS}/workspace.txt"
PACKAGE_PINS = f"{REMOTE_PINS}/packages"

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

# Settings the suite passes with --agent-env and the loop reads as-is.
PASSTHROUGH_SETTINGS = (
    "CC_TARGET_JSON",
    "CC_TURN_RETRIES",
    "CC_EMPTY_RETRIES",
    "CC_MAX_STEPS",
    "CC_TURN_TIMEOUT_SEC",
    "CC_TOOL_TIMEOUT_SEC",
)


class CourseAgent(BaseInstalledAgent):
    """Shared upload, install, exec and read-back. Subclasses name the
    benchmark and add its environment settings."""

    benchmark: str = ""
    loop_module: str = "context_cup_runner.loop"
    """What runs in the container once setup is done: the course's turn loop,
    or (the script agents in agent.py) the launcher of a whole agent's agent.sh."""

    capabilities = AgentCapabilities(atif=True, mcp_servers=True)

    _driver_drop: str | None = None
    """How run.sh switches to DRIVER_USER in this container; set by install."""

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
        """Where each package lands in the container: under its own folder
        name, which is its name there too (the suite refuses two packages
        with one), in CC_CHAIN's order."""
        return [f"{REMOTE_CHAIN}/{p.dir.name}" for p in chain.packages]

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
            "CC_PROTOCOL_DIR": REMOTE_PROTOCOL,
        }
        env.update(UV_ENV)
        if engine_chain(chain):
            # Whatever a setup.sh installs into the engine's venv stays on the
            # versions the workspace pins.
            env["UV_CONSTRAINT"] = WORKSPACE_PINS
        env["CC_PYTHON"] = RUNNER_PYTHON
        env["CC_NODE"] = NODE_BIN
        env["PATH"] = (
            f"{UV_DIR}:{RUNNER_VENV}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        )
        return env

    def trial_id(self) -> str:
        return str(self.logs_dir.parent.name)

    def stage_package(self, package_dir: Path, name: str | None = None) -> Path:
        """A copy without host-only clutter (node_modules and friends), so the
        upload carries the scripts and sources, not a pnpm tree. Staged under
        the package's folder name unless given another."""
        staged = Path(self.logs_dir) / "setup" / "chain" / (name or package_dir.name)
        if staged.exists():
            shutil.rmtree(staged)
        shutil.copytree(
            package_dir,
            staged,
            ignore=shutil.ignore_patterns(*UPLOAD_IGNORE),
            symlinks=False,
        )
        return staged

    def stage_pins(self, chain: DriverChain) -> Path:
        """The pin files for this trial: the workspace's, and one per package
        that declares its own dependencies, named like its chain directory."""
        check_python_root(chain)
        staged = Path(self.logs_dir) / "setup" / "pins"
        if staged.exists():
            shutil.rmtree(staged)
        (staged / "packages").mkdir(parents=True)
        workspace = workspace_pins()
        (staged / "workspace.txt").write_text(workspace)
        for package in chain.packages:
            if declares_dependencies(package):
                pins = package_pins(package.dir)
                if engine_chain(chain):
                    pins = without_pinned(pins, workspace)
                (staged / "packages" / f"{package.dir.name}.txt").write_text(pins)
        return staged

    def dependencies_command(self, chain: DriverChain, index: int) -> str:
        """Install package `index`'s declared dependencies into the chain's
        venv (the engine's, or a script agent's own, made here), pinned by
        its lock and, in an engine's venv, by the workspace's."""
        dirs = self.remote_chain_dirs(chain)
        venv = f"{dirs[0]}/.venv"
        pins = f"{PACKAGE_PINS}/{Path(dirs[index]).name}.txt"
        # Both explicitly: a --constraint flag replaces UV_CONSTRAINT from the
        # environment rather than adding to it.
        constraints = [pins, WORKSPACE_PINS] if engine_chain(chain) else [pins]
        make_venv = (
            f"{UV_BIN} venv --quiet --python {PYTHON_VERSION} {venv} && "
            if index == 0
            else ""
        )
        return (
            make_venv
            + f"{UV_BIN} pip install --quiet --python {venv}/bin/python "
            + f"-r {dirs[index]}/pyproject.toml "
            + " ".join(f"--constraint {c}" for c in constraints)
        )

    async def install(self, environment: BaseEnvironment) -> None:
        chain = self.host_chain()
        # The upload target's parent must exist, or harbor's `docker compose cp`
        # fails and falls back to a tar stream whose directories the agent user
        # cannot traverse.
        # Sticky, so a driver can add files there but not replace the ones
        # root writes (the proxy's calls.jsonl among them).
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {REMOTE_CHAIN} {AGENT_DIR} && chmod 1777 {AGENT_DIR}",
        )
        await environment.upload_dir(Path(__file__).parent, REMOTE_PACKAGE)
        await environment.upload_dir(
            self.stage_package(PROTOCOL_DIR, "protocol"), REMOTE_PROTOCOL
        )
        for package, remote in zip(
            chain.packages, self.remote_chain_dirs(chain), strict=True
        ):
            await environment.upload_dir(self.stage_package(package.dir), remote)
        await environment.upload_dir(self.stage_pins(chain), REMOTE_PINS)
        await self._open_install_root(environment)

        platform = await probe_platform(self, environment)
        await self._upload_uv(environment, platform)
        # Before the setup scripts, so every driver script can use it.
        await upload_node(self, environment, platform)
        deps = " ".join(shlex.quote(d) for d in IN_CONTAINER_DEPS)
        await self.exec_as_root(
            environment,
            command=(
                f"{UV_BIN} venv --quiet --python {PYTHON_VERSION} {RUNNER_VENV} && "
                f"{UV_BIN} pip install --quiet --no-sources --python {RUNNER_PYTHON} "
                f"--constraint {WORKSPACE_PINS} {REMOTE_PROTOCOL} {deps} && "
                f"mkdir -p {REMOTE_STATE} && chmod 777 {REMOTE_STATE}"
            ),
            env=UV_ENV,
            timeout_sec=900,
        )
        # Root first: each package's declared dependencies, then its setup.sh,
        # from its own directory.
        for index, (package, remote) in enumerate(
            zip(chain.packages, self.remote_chain_dirs(chain), strict=True)
        ):
            if declares_dependencies(package):
                await self.exec_as_root(
                    environment,
                    command=(
                        f"{self.dependencies_command(chain, index)} 2>&1 "
                        f"| tee {AGENT_DIR}/dependencies_{package.name}.txt"
                    ),
                    env=self.script_env(chain, index),
                    timeout_sec=900,
                )
            if package.script("setup.sh") is None:
                continue
            await self.exec_as_root(
                environment,
                # PATH is set in the command itself: some environments (Daytona)
                # exec through a login shell that resets PATH from the env.
                command=(
                    f"export PATH={UV_DIR}:{RUNNER_VENV}/bin:$PATH; "
                    f"cd {shlex.quote(remote)} && bash setup.sh 2>&1 "
                    f"| tee {AGENT_DIR}/setup_{package.name}.txt"
                ),
                env=self.script_env(chain, index),
                timeout_sec=900,
            )
        # setup.sh runs as root; run.sh runs as DRIVER_USER and must be able
        # to read and execute everything setup left behind (venvs included).
        await self._open_install_root(environment)

        # The proxy, holding the keys as root, and the proof the driver user
        # cannot read them.
        self._driver_drop = await create_driver_user(self, environment)
        await start_proxy(
            self,
            environment,
            platform=platform,
            target=json.loads(self._get_env("CC_TARGET_JSON") or "null"),
            save_bodies=self._get_env("CC_SAVE_BODIES") == "1",
        )
        await check_isolation(self, environment, self._driver_drop)

    async def _upload_uv(
        self, environment: BaseEnvironment, platform: tuple[str, str]
    ) -> None:
        """Put the pinned uv release at UV_BIN, built for the container."""
        binary = cached_uv_binary(uv_target_triple(*platform))
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
            "CC_PROXY_URL": PROXY_URL,
            # run.sh and teardown.sh inherit it: the node TypeScript engines run on.
            "CC_NODE": NODE_BIN,
        }
        if self._driver_drop:
            env["CC_DRIVER_USER"] = DRIVER_USER
            env["CC_DRIVER_DROP"] = self._driver_drop
        for key in PASSTHROUGH_SETTINGS:
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

        if not self._driver_drop:
            raise RuntimeError(
                f"install did not set up {DRIVER_USER}; driver code must not run as root"
            )
        env = self._loop_env(environment)
        await self.exec_as_agent(
            environment, command=f"mkdir -p {AGENT_DIR} {REMOTE_STATE}"
        )
        await wait_for_proxy(self, environment)
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    f"cd {INSTALL_ROOT} && {RUNNER_PYTHON} -m {self.loop_module} "
                    f"2>&1 </dev/null | tee {AGENT_DIR}/runner.txt"
                ),
                env=env,
                timeout_sec=None,
            )
        finally:
            await stop_proxy(self, environment)

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Token counts and cost come from the trial's calls.jsonl, read by the
        # suite; harbor's own record keeps only what the loop summarised.
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
