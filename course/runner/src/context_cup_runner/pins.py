"""Host side: the pinned versions a trial installs, exported from uv.lock.

The workspace's uv.lock pins everything the runner and the engines install.
A driver or agent that declares Python dependencies does so in a
`pyproject.toml` of its own, pinned by the `uv.lock` beside it. Each lock is
exported here, on the host, as a requirements file the container's uv reads
as constraints, so every trial of one commit installs the same versions.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from functools import cache
from pathlib import Path

import context_cup_protocol

from .chain import DriverChain, Package

WORKSPACE = Path(context_cup_protocol.__file__).resolve().parents[4]


def declares_dependencies(package: Package) -> bool:
    """A driver or agent whose `pyproject.toml` lists dependencies, which the
    runner installs. An empty list (the base drivers' template) installs
    nothing; an engine's `pyproject.toml` is the engine itself, which its own
    setup.sh installs."""
    if package.kind == "engine":
        return False
    project = context_cup_protocol.read_pyproject(package.dir).get("project")
    return isinstance(project, dict) and bool(project.get("dependencies"))


def engine_chain(chain: DriverChain) -> bool:
    """Whether the chain runs in an engine's venv, pinned by the workspace."""
    return chain.root.kind == "engine"


def check_python_root(chain: DriverChain) -> None:
    """Declared dependencies go into the chain root's venv: a Python engine's,
    or a script agent's own. A TypeScript engine has none."""
    root = chain.root
    if engine_chain(chain) and not (root.dir / "pyproject.toml").is_file():
        needy = [p.name for p in chain.packages if declares_dependencies(p)]
        if needy:
            raise ValueError(
                f"{', '.join(needy)} declares Python dependencies, but its chain "
                f"runs on the {root.name} engine, which has no Python venv"
            )


def without_pinned(pins: str, workspace: str) -> str:
    """A driver's pins less every package the workspace also pins. The two
    locks resolve apart, so they can pin a shared package differently; in an
    engine's venv the engine's versions win, and the driver's lock pins only
    what it adds."""
    taken = {name for line in workspace.splitlines() if (name := _pinned(line))}
    return "".join(
        f"{line}\n" for line in pins.splitlines() if _pinned(line) not in taken
    )


def _pinned(line: str) -> str | None:
    """The normalised package name a requirement line pins (PEP 503)."""
    match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", line)
    if not match or line.lstrip().startswith("#"):
        return None
    return re.sub(r"[-_.]+", "-", match.group(1)).lower()


@cache
def workspace_pins() -> str:
    """Every third-party version the workspace's uv.lock pins. `--frozen`:
    the lock as committed; `uv run` keeps it current in development."""
    return _export(WORKSPACE, "--frozen", "--all-packages", "--no-emit-workspace")


@cache
def package_pins(project: Path) -> str:
    """The versions a driver's own uv.lock pins for its `pyproject.toml`.
    `--locked`: a lock that no longer matches its pyproject fails here, on
    the host, rather than installing stale versions in every trial."""
    if not (project / "uv.lock").is_file():
        raise ValueError(
            f"{project} declares Python dependencies in pyproject.toml but has "
            "no uv.lock beside it: run `uv lock` there and commit it"
        )
    return _export(project, "--locked", "--no-emit-project")


def _export(project: Path, *flags: str) -> str:
    uv = shutil.which("uv")
    if uv is None:
        raise RuntimeError("uv is not on PATH; the host needs it to pin a trial")
    result = subprocess.run(
        [
            uv,
            "export",
            "--project",
            str(project),
            "--no-hashes",
            "--no-dev",
            "--no-header",
            "--no-annotate",
            *flags,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"uv export in {project} failed:\n{result.stderr.strip()}")
    return result.stdout
