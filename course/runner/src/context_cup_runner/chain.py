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
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def short_name(package_name: str) -> str:
    """`@context-cup-drivers/base_truncate` is the driver `base_truncate`: the
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
        self, package: Package, *, trial_id: str, state_dir: Path
    ) -> dict[str, str]:
        env = dict(os.environ)
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
) -> ScriptRun:
    try:
        completed = subprocess.run(
            ["bash", str(script), *args],
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
) -> ScriptRun:
    """Run the chain's run.sh for one turn, capturing stdout and stderr into
    the turn directory."""
    package, script = chain.run_script()
    env = chain.script_env(package, trial_id=trial_id, state_dir=state_dir)
    env["CC_TURN_DIR"] = str(turn_dir)
    run = run_script(
        script,
        [str(turn_dir / "input.json"), str(turn_dir / "output.json")],
        cwd=package.dir,
        env=env,
        timeout_sec=timeout_sec,
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
