"""The pins a trial installs, exported from the repo's real uv.lock files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from context_cup_runner.chain import DriverChain, Package
from context_cup_runner.pins import (
    WORKSPACE,
    check_python_root,
    declares_dependencies,
    engine_chain,
    package_pins,
    without_pinned,
    workspace_pins,
)


def package(
    root: Path, name: str, kind: str, *, pyproject: bool, deps: str = '["six"]'
) -> Package:
    directory = root / name
    directory.mkdir()
    (directory / "package.json").write_text(
        json.dumps({"name": name, "contextCup": {"kind": kind}})
    )
    if pyproject:
        (directory / "pyproject.toml").write_text(
            f"# a comment\n[project]\nname = 'x'\ndependencies = {deps}\n"
        )
    return Package.load(directory)


def test_only_drivers_and_agents_with_a_pyproject_declare_dependencies(
    tmp_path: Path,
) -> None:
    engine = package(tmp_path, "engine", "engine", pyproject=True)
    driver = package(tmp_path, "driver", "driver", pyproject=True)
    bare = package(tmp_path, "bare", "driver", pyproject=False)
    agent = package(tmp_path, "agent", "agent", pyproject=True)
    template = package(tmp_path, "template", "driver", pyproject=True, deps="[]")
    assert not declares_dependencies(engine), "an engine installs itself"
    assert declares_dependencies(driver) and declares_dependencies(agent)
    assert not declares_dependencies(bare)
    assert not declares_dependencies(template), "an empty list installs nothing"
    assert engine_chain(DriverChain([engine, driver]))
    assert not engine_chain(DriverChain([agent]))


def test_the_workspace_pins_what_the_runner_and_engines_install() -> None:
    pins = workspace_pins().splitlines()
    for name in ("openai", "anthropic", "httpx", "litellm", "mcp", "pydantic"):
        assert any(line.startswith(f"{name}==") for line in pins), name
    assert not any(line.startswith("context-cup") for line in pins), (
        "workspace members install from their directories, not pins"
    )


def test_a_driver_is_pinned_by_its_own_current_lock() -> None:
    pins = package_pins(WORKSPACE / "drivers" / "base_agent").splitlines()
    assert "litellm==1.83.0" in pins
    assert any(line.startswith("mcp==") for line in pins)


def test_a_driver_without_a_lock_fails_on_the_host(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'x'\n")
    with pytest.raises(ValueError, match="run `uv lock` there"):
        package_pins(tmp_path)


def test_in_an_engine_venv_the_workspace_pins_win_where_they_overlap() -> None:
    # The two locks resolve apart: base_agent's pins openai (and others) at
    # other versions than the workspace's, which as two sets of constraints
    # could never both hold.
    agent = package_pins(WORKSPACE / "drivers" / "base_agent")
    kept = without_pinned(agent, workspace_pins()).splitlines()
    assert not any(line.startswith("openai==") for line in kept)
    assert "mcp" not in {line.split("==")[0] for line in kept}
    assert (
        without_pinned(
            "Tiktoken==0.8\nregex==1\n# note\nzope.interface==7 ; python_version >= '3'\n",
            "regex==2\nzope-interface==6\n",
        )
        == "Tiktoken==0.8\n# note\n"  # comments stay; they constrain nothing
    )


def test_python_dependencies_need_a_python_venv(tmp_path: Path) -> None:
    typescript = package(tmp_path, "typescript", "engine", pyproject=False)
    python = package(tmp_path, "python", "engine", pyproject=True)
    driver = package(tmp_path, "helper", "driver", pyproject=True)
    with pytest.raises(ValueError, match="helper declares Python dependencies"):
        check_python_root(DriverChain([typescript, driver]))
    check_python_root(DriverChain([python, driver]))
