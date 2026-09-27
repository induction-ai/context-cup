"""run_engine: the turn mechanics every engine shares."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from context_cup_protocol import TurnInput, TurnOutput, run_engine


class Ctx:
    def __init__(self, turn: TurnInput, config: dict[str, Any]) -> None:
        self.turn, self.config = turn, config
        self.context_payload = dict(turn.context_payload)
        self.state = turn.state


def setup(tmp_path: Path, body: str) -> list[str]:
    driver = tmp_path / "d"
    driver.mkdir()
    (driver / "package.json").write_text(
        json.dumps(
            {
                "name": "@context-cup-drivers/d",
                "version": "1",
                "contextCup": {"kind": "driver", "config": {"k": 7}},
            }
        )
    )
    (driver / "driver.py").write_text(body)
    turn = {
        "trial_id": "t",
        "turn_id": "001_aaaaaa",
        "turn_index": 1,
        "first": True,
        "provider": {
            "name": "openai",
            "api_key": "cc-proxy",
            "client": {"base_url": "http://p/v1", "api": "responses"},
        },
        "target": {"model": "gpt-5.5"},
        "context_payload": {"input": []},
        "original_payload": {"input": []},
        "dirs": {"turn": str(tmp_path), "state": str(tmp_path / "state")},
    }
    (tmp_path / "in.json").write_text(json.dumps(turn))
    return [
        "--driver",
        str(driver),
        "--input",
        str(tmp_path / "in.json"),
        "--output",
        str(tmp_path / "out.json"),
    ]


def output(tmp_path: Path) -> TurnOutput:
    return TurnOutput.model_validate_json((tmp_path / "out.json").read_text())


def test_writes_the_response_edits_and_state(tmp_path: Path) -> None:
    argv = setup(
        tmp_path,
        """
def run(ctx):
    ctx.context_payload["input"].append({"role": "user", "content": "note"})
    ctx.state = {"k": ctx.config["k"]}
    return {"id": "resp_1", "output": []}
""",
    )
    assert run_engine(Ctx, "test", argv) == 0
    out = output(tmp_path)
    assert out.response == {"id": "resp_1", "output": []}
    assert out.context_payload == {"input": [{"role": "user", "content": "note"}]}
    assert out.state == {"k": 7}
    assert out.driver is not None and (out.driver.name, out.driver.engine) == (
        "d",
        "test",
    )


def test_accepts_an_sdk_response_object(tmp_path: Path) -> None:
    argv = setup(
        tmp_path,
        """
class R:
    def model_dump(self, mode="python", **kwargs):
        return {"id": "resp_sdk", "output": []}

def run(ctx):
    return R()
""",
    )
    assert run_engine(Ctx, "test", argv) == 0
    assert output(tmp_path).response["id"] == "resp_sdk"


@pytest.mark.parametrize(
    ("body", "error"),
    [
        ("def prepare(ctx):\n    pass\n", "must define run(ctx)"),
        ("def run(ctx):\n    return 'text'\n", "provider's response"),
    ],
)
def test_rejects_a_driver_without_run_or_a_non_response(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], body: str, error: str
) -> None:
    assert run_engine(Ctx, "test", setup(tmp_path, body)) == 1
    assert error in capsys.readouterr().err
    assert not (tmp_path / "out.json").exists()


def test_finish_turns_the_drivers_result_into_the_response(tmp_path: Path) -> None:
    argv = setup(tmp_path, "def run(ctx):\n    return 'an agent'\n")

    def finish(ctx: Ctx, result: object) -> dict[str, object]:
        return {"id": "resp_f", "built_from": result}

    assert run_engine(Ctx, "test", argv, finish=finish) == 0
    assert output(tmp_path).response == {"id": "resp_f", "built_from": "an agent"}


def test_an_sdk_response_is_written_with_only_the_fields_the_provider_sent():

    from pydantic import BaseModel

    from context_cup_protocol.engine import as_payload

    class Item(BaseModel):
        type: str
        id: str
        status: str | None = None

    class Response(BaseModel):
        id: str
        output: list[Item]

    raw = {"id": "resp_1", "output": [{"type": "reasoning", "id": "rs_1"}]}
    assert as_payload(Response.model_validate(raw)) == raw
