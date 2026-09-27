"""The turn mechanics every engine shares: an engine supplies the `ctx` its
drivers' `run(ctx)` receives, and `run_engine` does the rest."""

from __future__ import annotations

import argparse
import importlib.util
import sys
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from .manifest import Manifest, read_manifest
from .models import DriverInfo, Payload, TurnInput, TurnOutput


class EngineContext(Protocol):
    context_payload: Payload
    state: Any


MakeContext = Callable[[TurnInput, dict[str, Any]], EngineContext]
Finish = Callable[[Any, Any], Any]
"""Turns what `run(ctx)` returned into the turn's response, for engines whose
drivers return something else (a configured agent, say)."""


def load_driver(driver_dir: Path) -> tuple[Manifest, Any]:
    """The driver's manifest and its imported driver.py."""
    manifest = read_manifest(driver_dir) or Manifest()
    spec = importlib.util.spec_from_file_location("driver", driver_dir / "driver.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"no driver.py in {driver_dir}")
    sys.path.insert(0, str(driver_dir))  # a driver may split itself into files
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "run", None)):
        raise TypeError(f"{driver_dir / 'driver.py'} must define run(ctx)")
    return manifest, module


def as_payload(value: Any) -> Payload:
    """What `run` returned, as JSON: a dict, or an SDK response object."""
    if hasattr(value, "model_dump"):
        # Only the fields the provider actually sent: an SDK object dumps its
        # unsent optional fields as null, and a provider rejects those when
        # the course sends the response back as input next turn.
        value = value.model_dump(mode="json", exclude_unset=True)
    if not isinstance(value, dict):
        raise TypeError(
            f"run(ctx) must return the provider's response, not {type(value).__name__}"
        )
    return value


def run_turn(
    make_ctx: MakeContext,
    engine: str,
    driver_dir: Path,
    turn: TurnInput,
    finish: Finish | None = None,
) -> TurnOutput:
    manifest, module = load_driver(driver_dir)
    Path(turn.dirs.state).mkdir(parents=True, exist_ok=True)
    ctx = make_ctx(turn, manifest.config)
    result = module.run(ctx)
    response = as_payload(finish(ctx, result) if finish else result)
    name = driver_dir.resolve().name
    return TurnOutput(
        turn_id=turn.turn_id,
        response=response,
        context_payload=ctx.context_payload,
        state=ctx.state,
        driver=DriverInfo(name=name, engine=engine, version=manifest.version),
    )


def run_engine(
    make_ctx: MakeContext,
    engine: str,
    argv: list[str] | None = None,
    finish: Finish | None = None,
) -> int:
    """`--driver DIR --input in.json --output out.json`: one turn, exit 0, or
    a traceback on stderr and exit 1.

    An engine's entry point is a call to this. It reads `input.json`, loads
    the driver's manifest (`read_manifest`) and `driver.py` (the driver's
    directory goes on `sys.path`, so it may import sibling files), creates the
    state directory, and builds `ctx` with `make_ctx(turn, config)`, the
    manifest's `config`. It
    calls `run(ctx)`, passes the result through `finish(ctx, result)` when
    the engine gives one, and takes it as the response: a dict, or an SDK
    object dumped with only the fields the provider sent. `output.json` gets
    that response plus `ctx.context_payload` and `ctx.state` as they stand
    after the call. Any exception, from the driver or here, fails the turn;
    the runner retries it."""
    parser = argparse.ArgumentParser(prog=f"engine-{engine}")
    for flag in ("--driver", "--input", "--output"):
        parser.add_argument(flag, required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        turn = TurnInput.model_validate_json(args.input.read_text())
        output = run_turn(make_ctx, engine, args.driver, turn, finish)
    except Exception:  # noqa: BLE001 - any failure is the turn failing
        traceback.print_exc(file=sys.stderr)
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output.model_dump_json(indent=2))
    return 0
