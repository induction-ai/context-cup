"""Load a driver directory: its package.json manifest plus its entry module."""

from __future__ import annotations

import importlib.util
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any


@dataclass
class DriverSpec:
    name: str
    engine: str
    entry: str
    version: str | None
    description: str
    config: dict[str, Any] = field(default_factory=dict)
    dir: Path = field(default_factory=Path)

    @classmethod
    def load(cls, driver_dir: Path) -> DriverSpec:
        """Read the driver's package.json; protocol fields live under contextCup."""
        manifest = driver_dir / "package.json"
        if not manifest.is_file():
            raise FileNotFoundError(f"{manifest} not found")
        data = json.loads(manifest.read_text())
        cc = data.get("contextCup") or {}
        full_name = str(data.get("name", driver_dir.name))
        name = full_name.split("/", 1)[1] if "/" in full_name else full_name
        extends = str(cc.get("extends") or "")
        if not extends.endswith("engine-python"):
            raise ValueError(
                f"driver {name!r} extends {extends or 'nothing'!r}, not the python engine"
            )
        return cls(
            name=name,
            engine="python",
            entry=str(cc.get("entry", "driver.py")),
            version=data.get("version"),
            description=str(data.get("description", "")),
            config=dict(cc.get("config") or {}),
            dir=driver_dir,
        )


def load_driver_module(spec: DriverSpec) -> ModuleType:
    entry = spec.dir / spec.entry
    if not entry.is_file():
        raise FileNotFoundError(f"driver entry {entry} not found")
    module_name = f"context_cup_driver_{spec.name}"
    loader_spec = importlib.util.spec_from_file_location(module_name, entry)
    if loader_spec is None or loader_spec.loader is None:
        raise ImportError(f"cannot import driver entry {entry}")
    module = importlib.util.module_from_spec(loader_spec)
    # Let a driver split itself into sibling files.
    if str(spec.dir) not in sys.path:
        sys.path.insert(0, str(spec.dir))
    sys.modules[module_name] = module
    loader_spec.loader.exec_module(module)
    if not callable(getattr(module, "run", None)):
        raise TypeError(f"driver {spec.name} must define run(ctx)")
    return module
