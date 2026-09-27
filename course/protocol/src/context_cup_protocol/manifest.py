"""A package's manifest, in its language's format: the `contextCup` block of
its `package.json`, else the `[tool.context-cup]` table of its
`pyproject.toml`. Names in either file are ignored: a package is its folder.
`manifest.ts` is the TypeScript twin, read by the suite and the TypeScript
engines; tests/test_protocol_contract.py checks the two agree."""

from __future__ import annotations

import json
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Manifest:
    settings: dict[str, Any] = field(default_factory=dict)
    """The `contextCup` block: kind, extends, providers, config, ..."""
    version: str | None = None
    description: str | None = None

    @property
    def config(self) -> dict[str, Any]:
        config = self.settings.get("config")
        return dict(config) if isinstance(config, dict) else {}


def read_manifest(package_dir: Path) -> Manifest | None:
    """The package's manifest, or None for a directory with neither."""
    json_file = package_dir / "package.json"
    if json_file.is_file():
        try:
            spec = json.loads(json_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"{json_file}: {error}") from error
        if not isinstance(spec, dict):
            raise TypeError(f"{json_file} must hold a JSON object")
        if isinstance(spec.get("contextCup"), dict):
            return Manifest(
                spec["contextCup"],
                _text(spec.get("version")),
                _text(spec.get("description")),
            )
    pyproject = read_pyproject(package_dir)
    block = _table(_table(pyproject, "tool"), "context-cup")
    if block:
        project = _table(pyproject, "project")
        return Manifest(
            block, _text(project.get("version")), _text(project.get("description"))
        )
    return None


def read_pyproject(package_dir: Path) -> dict[str, Any]:
    """The package's parsed `pyproject.toml`, `{}` without one; a file that
    is not valid TOML fails naming itself."""
    path = package_dir / "pyproject.toml"
    if not path.is_file():
        return {}
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as error:
        raise ValueError(f"{path}: {error}") from error


def _table(spec: dict[str, Any], key: str) -> dict[str, Any]:
    """`spec[key]` when it is a table, else `{}`: what is not a table is not
    ours to read, as `manifest.ts` treats it."""
    value = spec.get(key)
    return value if isinstance(value, dict) else {}


def _text(value: Any) -> str | None:
    return None if value is None else str(value)
