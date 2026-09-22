"""`python3 -m context_cup_engine --driver DIR --input in.json --output out.json`

Runs one turn: loads the driver, hands it the context, and writes what the
model answered plus every call that happened along the way.
"""

from __future__ import annotations

import argparse
import copy
import sys
import traceback
from pathlib import Path
from typing import Any

from .drivers import DriverSpec, load_driver_module
from .engine import TurnContext
from .protocol import DriverInfo, Payload, TurnInput, TurnOutput
from .recorder import global_recorder

__version__ = "0.2.0"


def _as_payload(value: Any) -> Payload:
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        dumped = value.model_dump(mode="json")
        if isinstance(dumped, dict):
            return dumped
    if hasattr(value, "to_dict"):
        dumped = value.to_dict()
        if isinstance(dumped, dict):
            return dumped
    raise TypeError(
        f"run(ctx) must return the provider's response object, got {type(value).__name__}"
    )


def run_turn(driver_dir: Path, turn: TurnInput) -> TurnOutput:
    spec = DriverSpec.load(driver_dir)
    module = load_driver_module(spec)
    recorder = global_recorder()
    recorder.install()
    Path(turn.dirs.state).mkdir(parents=True, exist_ok=True)
    ctx = TurnContext(
        turn=turn,
        config=spec.config,
        recorder=recorder,
        context_payload=copy.deepcopy(turn.context_payload),
        state=copy.deepcopy(turn.state),
    )
    response = _as_payload(module.run(ctx))
    return TurnOutput(
        turn_id=turn.turn_id,
        response=response,
        context_payload=ctx.context_payload,
        state=ctx.state,
        calls=ctx.calls(),
        driver=DriverInfo(name=spec.name, engine=spec.engine, version=spec.version),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="context_cup_engine")
    parser.add_argument("--driver", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)

    try:
        turn = TurnInput.model_validate_json(args.input.read_text())
        output = run_turn(args.driver, turn)
    except Exception:  # noqa: BLE001 - any failure is the turn failing
        traceback.print_exc(file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output.model_dump_json(indent=2, exclude_none=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
