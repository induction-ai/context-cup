"""Engine snapshots: a turn reads the last accepted turn's, never its own
discarded attempt's, and older ones are cleared."""

from __future__ import annotations

from pathlib import Path

from context_cup_protocol import (
    Dirs,
    ProviderClient,
    ProviderInfo,
    Target,
    TurnInput,
    load_snapshot,
    save_snapshot,
)


def turn(tmp_path: Path, index: int) -> TurnInput:
    return TurnInput(
        trial_id="t",
        turn_id=f"{index:03d}_aaaaaa",
        turn_index=index,
        first=index == 1,
        provider=ProviderInfo(
            name="openai",
            api_key="cc-proxy",
            client=ProviderClient(base_url="http://p/v1", api="responses"),
        ),
        target=Target(model="gpt-5.5"),
        context_payload={},
        original_payload={},
        dirs=Dirs(turn=str(tmp_path), state=str(tmp_path)),
    )


def test_a_retry_reads_the_last_accepted_turn(tmp_path: Path) -> None:
    assert load_snapshot(turn(tmp_path, 1), "ctx") is None
    save_snapshot(turn(tmp_path, 1), "ctx", {"n": 1})
    save_snapshot(turn(tmp_path, 2), "ctx", {"n": 2})  # later thrown away
    assert load_snapshot(turn(tmp_path, 2), "ctx") == {"n": 1}
    save_snapshot(turn(tmp_path, 2), "ctx", {"n": 22})  # the accepted retry
    save_snapshot(turn(tmp_path, 3), "ctx", {"n": 3})
    assert load_snapshot(turn(tmp_path, 4), "ctx") == {"n": 3}
    assert sorted(p.name for p in (tmp_path / "ctx").iterdir()) == ["3.json"]
