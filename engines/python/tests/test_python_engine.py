"""The Python engine's ctx, end to end through its entry point."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from context_cup_protocol import TurnOutput

DRIVER = """
def run(ctx):
    assert ctx.first and ctx.provider.name == "openai" and ctx.target.model == "gpt-5.5"
    conversation = ctx.view()
    assert [m.role for m in conversation.messages] == ["user", "assistant", "tool"]
    conversation.messages[-1].text = "clipped"
    ctx.write(conversation)
    ctx.state = {"seen": len(conversation.messages)}
    return {"id": "resp_1", "output": []}
"""


def test_a_driver_edits_through_the_view(tmp_path: Path) -> None:
    driver = tmp_path / "driver"
    driver.mkdir()
    (driver / "package.json").write_text(json.dumps({"name": "@context-cup-drivers/d"}))
    (driver / "driver.py").write_text(DRIVER)
    payload = {
        "model": "gpt-5.5",
        "instructions": "be brief",
        "input": [
            {"role": "user", "content": "hello"},
            {
                "type": "function_call",
                "call_id": "c1",
                "name": "get_balance",
                "arguments": "{}",
            },
            {"type": "function_call_output", "call_id": "c1", "output": "y" * 50},
        ],
    }
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
        "context_payload": payload,
        "original_payload": payload,
        "dirs": {"turn": str(tmp_path), "state": str(tmp_path / "state")},
    }
    (tmp_path / "in.json").write_text(json.dumps(turn))
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "context_cup_engine",
            "--driver",
            str(driver),
            "--input",
            str(tmp_path / "in.json"),
            "--output",
            str(tmp_path / "out.json"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    out = TurnOutput.model_validate_json((tmp_path / "out.json").read_text())
    assert out.response["id"] == "resp_1" and out.state == {"seen": 3}
    assert json.dumps(out.context_payload) == json.dumps(payload).replace(
        "y" * 50, "clipped"
    )
    assert out.driver is not None and out.driver.engine == "python"
