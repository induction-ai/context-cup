import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import write_driver
from context_cup_engine.__main__ import main, run_turn
from context_cup_engine.protocol import TurnInput, TurnOutput

DRIVERS = Path(__file__).resolve().parents[3] / "drivers"

DRIVER_NO_NETWORK = """
def run(ctx):
    assert ctx.first is True and ctx.provider == "openai"
    assert ctx.provider_info.api_key == "sk-test"
    ctx.context_payload["input"].append({"role": "user", "content": "note to self"})
    ctx.state = {"turns_seen": (ctx.state or {}).get("turns_seen", 0) + 1}
    return {"id": "resp_1", "output": [{"type": "function_call", "call_id": "call_1",
                                       "name": "get_balance", "arguments": "{}"}]}
"""

DRIVER_BAD_RETURN = """
def run(ctx):
    return "not a response"
"""

DRIVER_NO_RUN = """
def prepare(messages, ctx):
    return messages
"""


def test_run_returns_response_edited_payload_and_state(
    tmp_path: Path, turn_input: TurnInput
):
    driver = write_driver(tmp_path / "d", "d_test", DRIVER_NO_NETWORK)
    out = run_turn(driver, turn_input)
    assert out.protocol == 2 and out.turn_id == "001_abc123"
    assert out.response["output"][0]["call_id"] == "call_1"
    assert out.context_payload["input"][-1]["content"] == "note to self"
    assert (
        turn_input.context_payload["input"][-1]["role"] == "user"
        and len(turn_input.context_payload["input"]) == 1
    ), "input is not mutated"
    assert out.state == {"turns_seen": 1}
    assert out.calls == []
    assert out.driver.name == "d_test" and out.driver.engine == "python"


def test_base_passthrough_posts_the_context_payload(
    tmp_path: Path, turn_input: TurnInput, monkeypatch
):
    from context_cup_engine import client

    seen = {}

    def fake_call(provider, payload, **kwargs):
        seen["provider"], seen["payload"] = provider, payload
        return {
            "id": "resp_2",
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "hi"}]}
            ],
        }

    monkeypatch.setattr(client, "call", fake_call)
    out = run_turn(DRIVERS / "base_passthrough", turn_input)
    assert seen["provider"].name == "openai"
    assert seen["payload"] == turn_input.context_payload
    assert out.response["id"] == "resp_2"


def test_base_truncate_clips_only_oversized_tool_outputs(
    tmp_path: Path, turn_input: TurnInput, monkeypatch
):
    from context_cup_engine import client

    turn_input.context_payload["input"] += [
        {"type": "function_call_output", "call_id": "a", "output": "short"},
        {"type": "function_call_output", "call_id": "b", "output": "y" * 50},
    ]
    sent = {}
    monkeypatch.setattr(
        client, "call", lambda p, payload, **k: sent.update(payload) or {"output": []}
    )
    write_driver(tmp_path / "unused", "unused", "def run(ctx): pass")
    import json as _json

    spec = _json.loads((DRIVERS / "base_truncate" / "package.json").read_text())
    spec["contextCup"]["config"] = {"max_bytes": 10}
    d = tmp_path / "base_truncate"
    d.mkdir()
    (d / "package.json").write_text(_json.dumps(spec))
    (d / "driver.py").write_text((DRIVERS / "base_truncate" / "driver.py").read_text())
    run_turn(d, turn_input)
    outputs = [i for i in sent["input"] if i.get("type") == "function_call_output"]
    assert outputs[0]["output"] == "short"
    assert (
        outputs[1]["output"].startswith("y" * 10)
        and "40 bytes removed" in outputs[1]["output"]
    )


def test_cli_writes_output_json(tmp_path: Path, turn_input: TurnInput):
    driver = write_driver(tmp_path / "d", "d_test", DRIVER_NO_NETWORK)
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "out" / "output.json"
    input_path.write_text(turn_input.model_dump_json())
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "context_cup_engine",
            "--driver",
            str(driver),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    out = TurnOutput.model_validate_json(output_path.read_text())
    assert out.response["id"] == "resp_1" and out.state == {"turns_seen": 1}


def test_cli_fails_when_run_returns_a_non_response(
    tmp_path: Path, turn_input: TurnInput, capsys
):
    driver = write_driver(tmp_path / "d", "d_bad", DRIVER_BAD_RETURN)
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(turn_input.model_dump_json())
    assert (
        main(
            [
                "--driver",
                str(driver),
                "--input",
                str(input_path),
                "--output",
                str(output_path),
            ]
        )
        == 1
    )
    assert (
        not output_path.exists()
        and "provider's response object" in capsys.readouterr().err
    )


def test_driver_without_run_is_rejected(tmp_path: Path, turn_input: TurnInput):
    driver = write_driver(tmp_path / "d", "d_old", DRIVER_NO_RUN)
    with pytest.raises(TypeError, match="run\\(ctx\\)"):
        run_turn(driver, turn_input)


def test_input_rejects_unknown_provider(turn_input: TurnInput):
    data = json.loads(turn_input.model_dump_json())
    data["provider"]["name"] = "fireworks"
    with pytest.raises(Exception, match="fireworks|provider"):
        TurnInput.model_validate(data)
