"""A driver chain: package directories root to leaf, each a pnpm package
whose package.json carries a `contextCup` block, with optional setup.sh /
run.sh / teardown.sh (docs/protocol.md).

The suite resolves `extends` on the host and hands the runner the chain as
CC_DRIVER_CHAIN, colon separated. Inside the container the same variable
names the uploaded copies.
"""

from __future__ import annotations

import json
import os
import pwd
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def short_name(package_name: str) -> str:
    """`@context-cup-drivers/base_python` is the driver `base_python`: the
    scope is dropped whichever it is."""
    return package_name.rsplit("/", 1)[-1]


@dataclass(frozen=True)
class Package:
    dir: Path
    name: str
    kind: str
    version: str | None
    config: dict[str, Any]

    @classmethod
    def load(cls, package_dir: Path) -> Package:
        manifest = package_dir / "package.json"
        try:
            spec = json.loads(manifest.read_text(encoding="utf-8"))
        except FileNotFoundError:
            spec = {}
        if not isinstance(spec, dict):
            raise TypeError(f"{manifest} must hold a JSON object")
        block = spec.get("contextCup")
        block = block if isinstance(block, dict) else {}
        config = block.get("config")
        return cls(
            dir=package_dir,
            name=short_name(str(spec.get("name") or package_dir.name)),
            kind=str(block.get("kind") or "driver"),
            version=str(spec["version"]) if spec.get("version") is not None else None,
            config=config if isinstance(config, dict) else {},
        )

    def script(self, name: str) -> Path | None:
        path = self.dir / name
        return path if path.is_file() else None


@dataclass(frozen=True)
class DriverChain:
    packages: list[Package]  # root first

    @classmethod
    def from_dirs(cls, dirs: list[Path]) -> DriverChain:
        if not dirs:
            raise ValueError("driver chain is empty")
        return cls([Package.load(d) for d in dirs])

    @classmethod
    def from_env_value(cls, value: str) -> DriverChain:
        return cls.from_dirs([Path(part) for part in value.split(os.pathsep) if part])

    @property
    def leaf(self) -> Package:
        return self.packages[-1]

    @property
    def root(self) -> Package:
        return self.packages[0]

    def env_value(self) -> str:
        return os.pathsep.join(str(p.dir) for p in self.packages)

    def run_script(self) -> tuple[Package, Path]:
        """The run.sh nearest the leaf; parents' run.sh are shadowed."""
        for package in reversed(self.packages):
            script = package.script("run.sh")
            if script:
                return package, script
        listing = "; ".join(_describe_dir(p.dir) for p in self.packages)
        raise ValueError(f"no run.sh anywhere in the driver chain ({listing})")

    def setup_scripts(self) -> list[tuple[Package, Path]]:
        return [(p, s) for p in self.packages if (s := p.script("setup.sh"))]

    def teardown_scripts(self) -> list[tuple[Package, Path]]:
        return [
            (p, s) for p in reversed(self.packages) if (s := p.script("teardown.sh"))
        ]

    def info(self) -> dict[str, Any]:
        engines = [p.name for p in self.packages if p.kind == "engine"]
        return {
            "name": self.leaf.name,
            "version": self.leaf.version,
            "engine": engines[-1] if engines else None,
            "chain": [p.name for p in self.packages],
        }

    def script_env(
        self,
        package: Package,
        *,
        trial_id: str,
        state_dir: Path,
        extra: dict[str, str] | None = None,
    ) -> dict[str, str]:
        env = dict(os.environ)
        if extra:
            env.update(extra)
        env.update(
            {
                "CC_DRIVER_DIR": str(self.leaf.dir),
                "CC_SELF_DIR": str(package.dir),
                "CC_CHAIN": self.env_value(),
                "CC_STATE_DIR": str(state_dir),
                "CC_TRIAL_ID": trial_id,
            }
        )
        return env


DROP_TOOLS = ("setpriv", "runuser", "su")
"""Ways to run a command as another user, in the order the runner tries them
when it sets a container up. Which one works depends on the image."""


def drop_argv(tool: str, user: str, uid: int, gid: int, argv: list[str]) -> list[str]:
    """`argv` run as `user` (uid, gid) through `tool`. Each keeps the
    caller's environment apart from what the tool itself resets."""
    if tool == "setpriv":
        return [
            "setpriv",
            f"--reuid={uid}",
            f"--regid={gid}",
            "--clear-groups",
            *argv,
        ]
    if tool == "runuser":
        return ["runuser", "-u", user, "--", *argv]
    if tool == "su":
        return ["su", "-s", "/bin/sh", "-c", shlex.join(argv), user]
    raise ValueError(f"unknown privilege drop tool {tool!r}")


@dataclass(frozen=True)
class RunAs:
    """The unprivileged user driver scripts run as, and how to switch to it
    (CC_DRIVER_USER and CC_DRIVER_DROP, set by the runner's host side)."""

    user: str
    tool: str
    uid: int
    gid: int
    home: str

    @classmethod
    def from_env(cls, env: dict[str, str]) -> RunAs | None:
        user = env.get("CC_DRIVER_USER")
        if not user:
            return None
        tool = env.get("CC_DRIVER_DROP") or ""
        if tool not in DROP_TOOLS:
            raise ValueError(
                f"CC_DRIVER_DROP must be one of {DROP_TOOLS}, not {tool!r}"
            )
        entry = pwd.getpwnam(user)
        return cls(user, tool, entry.pw_uid, entry.pw_gid, entry.pw_dir)

    def wrap(self, argv: list[str]) -> list[str]:
        return drop_argv(self.tool, self.user, self.uid, self.gid, argv)

    def env(self, env: dict[str, str]) -> dict[str, str]:
        return {**env, "HOME": self.home, "USER": self.user, "LOGNAME": self.user}

    def describe(self) -> str:
        """Who a switched command really runs as, checked with `id -u`."""
        uid = subprocess.run(
            self.wrap(["id", "-u"]), capture_output=True, text=True, check=False
        ).stdout.strip()
        return f"{self.user} (uid {uid or '?'}) via {self.tool}"


@dataclass(frozen=True)
class ScriptRun:
    returncode: int
    stdout: str
    stderr: str


def run_script(
    script: Path,
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout_sec: float | None,
    run_as: RunAs | None = None,
) -> ScriptRun:
    """`bash script args`, as `run_as` when given (driver code never runs as
    root during the loop)."""
    argv = ["bash", str(script), *args]
    if run_as is not None:
        argv, env = run_as.wrap(argv), run_as.env(env)
    try:
        completed = subprocess.run(
            argv,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
        return ScriptRun(completed.returncode, completed.stdout, completed.stderr)
    except subprocess.TimeoutExpired as exc:
        return ScriptRun(
            -1,
            _decode(exc.stdout),
            _decode(exc.stderr)
            + f"\n[runner] {script.name} timed out after {timeout_sec}s\n",
        )


def run_turn_script(
    chain: DriverChain,
    turn_dir: Path,
    *,
    trial_id: str,
    state_dir: Path,
    timeout_sec: float | None,
    extra_env: dict[str, str] | None = None,
    run_as: RunAs | None = None,
) -> ScriptRun:
    """Run the chain's run.sh for one turn, capturing stdout and stderr into
    the turn directory. Under `run_as` the turn directory is opened up so the
    driver can write its output there."""
    package, script = chain.run_script()
    env = chain.script_env(
        package, trial_id=trial_id, state_dir=state_dir, extra=extra_env
    )
    env["CC_TURN_DIR"] = str(turn_dir)
    if run_as is not None:
        turn_dir.chmod(0o777)
    run = run_script(
        script,
        [str(turn_dir / "input.json"), str(turn_dir / "output.json")],
        cwd=package.dir,
        env=env,
        timeout_sec=timeout_sec,
        run_as=run_as,
    )
    (turn_dir / "stdout.txt").write_text(run.stdout, encoding="utf-8")
    (turn_dir / "stderr.txt").write_text(run.stderr, encoding="utf-8")
    return run


def _describe_dir(path: Path) -> str:
    try:
        names = sorted(entry.name for entry in path.iterdir())
    except OSError as exc:
        return f"{path}: {exc.__class__.__name__}: {exc}"
    return f"{path}: {', '.join(names) or 'empty'}"


def _decode(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
