"""An engine's own bookkeeping, kept only for turns the runner accepted.

An engine that carries something across turns in `dirs.state` (a working
conversation, an agent's history) must not let an attempt the runner then
threw away (an empty reply, a failed turn) leak into the retry. `state`
itself is safe, since the runner echoes it back only from an accepted
output, but a file an engine writes is not. So each turn's snapshot is
saved under its `turn_index`, which every attempt at a turn shares and
which moves on only when a turn is accepted: a turn reads the snapshot of
`turn_index - 1`, and a retry overwrites its discarded attempt's.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import TurnInput


def _dir(turn: TurnInput, name: str) -> Path:
    return Path(turn.dirs.state) / name


def load_snapshot(turn: TurnInput, name: str) -> Any | None:
    """The snapshot the last accepted turn saved under `name`, or None on the
    first turn or when there is none. Older snapshots are removed."""
    if turn.first:
        return None
    folder = _dir(turn, name)
    previous = turn.turn_index - 1
    for path in folder.glob("*.json") if folder.is_dir() else []:
        if path.stem.isdigit() and int(path.stem) < previous:
            path.unlink(missing_ok=True)
    path = folder / f"{previous}.json"
    return json.loads(path.read_text()) if path.exists() else None


def save_snapshot(turn: TurnInput, name: str, value: Any) -> None:
    """Save this turn's snapshot under `name`; the next turn loads it."""
    folder = _dir(turn, name)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{turn.turn_index}.json").write_text(json.dumps(value))
