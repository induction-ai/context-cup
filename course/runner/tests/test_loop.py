from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import pytest
from context_cup_protocol import Utterance
from context_cup_runner.loop import Trial, TrialError
from context_cup_runner.protocol import new_turn_id

from tests.conftest import MemoryEnvironment, make_settings, write_script

TURN_ID = re.compile(r"^\d{3}_[a-z0-9]{6}$")


def call(call_id: str, name: str, **args) -> dict:
    return {"id": call_id, "name": name, "args": args}


def run(trial: Trial):
    return asyncio.run(trial.run())


def turn_inputs(agent_dir: Path) -> list[dict]:
    dirs = sorted(p for p in (agent_dir / "turns").iterdir())
    return [json.loads((d / "input.json").read_text()) for d in dirs]


def test_turn_ids_are_ordered_and_well_formed():
    ids = [new_turn_id(i) for i in (1, 2, 10, 999)]
    assert all(TURN_ID.match(i) for i in ids)
    assert ids == sorted(ids)
    assert ids[0].startswith("001_") and ids[3].startswith("999_")
    with pytest.raises(ValueError):
        new_turn_id(0)


def test_two_turn_happy_path_openai(workspace):
    write_script(
        workspace["driver"],
        [
            {
                "text": None,
                "tool_calls": [call("c1", "echo", x=1)],
                "state": {"n": 1},
            },
            {"text": "all done"},
        ],
    )
    env = MemoryEnvironment()
    trial = Trial(make_settings(workspace), env)
    result = run(trial)

    assert result.stop_reason == "final_message"
    assert result.turns == 2
    assert result.env_tool_calls == 1
    assert env.closed_with == "final_message"
    assert env.received[0][0].id == "c1" and env.received[0][0].arguments == {"x": 1}

    turn_dirs = sorted(p.name for p in (workspace["agent"] / "turns").iterdir())
    assert len(turn_dirs) == 2 and all(TURN_ID.match(d) for d in turn_dirs)
    for name in ("input.json", "output.json", "stdout.txt", "stderr.txt"):
        assert (workspace["agent"] / "turns" / turn_dirs[0] / name).exists()

    first, second = turn_inputs(workspace["agent"])
    assert first["first"] is True and second["first"] is False
    assert first["provider"]["name"] == "openai"
    assert first["provider"]["client"] == {
        "base_url": "http://proxy.test:1/t/task-1__abc123/openai/v1",
        "api": "responses",
    }
    assert first["state"] == {} and second["state"] == {"n": 1}
    assert second["turn_index"] == 2
    assert second["dirs"]["workspace"] == "/work"
    assert second["dirs"]["state"].endswith("driver_state")

    payload = second["context_payload"]
    assert payload["instructions"] == "sys"
    assert payload["tools"][0] == {
        "type": "function",
        "name": "echo",
        "description": "",
        "parameters": {"type": "object"},
    }
    assert payload["reasoning"] == {"effort": "low"} and payload["store"] is False
    kinds = [(i.get("type"), i.get("role")) for i in payload["input"]]
    assert kinds == [
        (None, "user"),
        ("reasoning", None),
        ("function_call", None),
        ("function_call_output", None),
    ]
    assert payload["input"][3] == {
        "type": "function_call_output",
        "call_id": "c1",
        "output": "ok:echo",
    }
    assert second["original_payload"] == payload
    # The final payload files hold the whole conversation.
    original = json.loads((workspace["agent"] / "original_payload.json").read_text())
    assert original["input"][-1]["type"] == "message"
    assert (workspace["agent"] / "context_payload.json").exists()


def test_driver_context_payload_and_state_carry_over(workspace):
    compressed = {"model": "gpt-test", "input": [{"role": "user", "content": "short"}]}
    write_script(
        workspace["driver"],
        [
            {
                "text": None,
                "tool_calls": [call("c1", "echo")],
                "context_payload": compressed,
                "state": {"seen": ["c1"]},
            },
            {"text": None, "tool_calls": [call("c2", "echo")]},
            {"text": "bye", "state": None},
        ],
    )
    run(Trial(make_settings(workspace), MemoryEnvironment()))
    inputs = turn_inputs(workspace["agent"])
    # Turn 2 sees the driver's compressed payload plus the appended response
    # and tool result, while the original keeps everything.
    ctx = inputs[1]["context_payload"]
    assert ctx["input"][0] == {"role": "user", "content": "short"}
    assert [i.get("type") for i in ctx["input"][1:]] == [
        "reasoning",
        "function_call",
        "function_call_output",
    ]
    assert "instructions" not in ctx
    assert inputs[1]["original_payload"]["instructions"] == "sys"
    assert len(inputs[1]["original_payload"]["input"]) == 4
    assert inputs[1]["state"] == {"seen": ["c1"]}
    # Absent state leaves it unchanged; an explicit null replaces it.
    assert inputs[2]["state"] == {"seen": ["c1"]}
    assert len(inputs[2]["context_payload"]["input"]) == 7
    final_ctx = json.loads((workspace["agent"] / "context_payload.json").read_text())
    assert final_ctx["input"][0]["content"] == "short"


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
def test_two_turn_happy_path_other_providers(workspace, provider):
    write_script(
        workspace["driver"],
        [
            {"text": "let me check", "tool_calls": [call("c1", "echo", a=1)]},
            {"text": "bye"},
        ],
    )
    env = MemoryEnvironment(
        opening=[Utterance("assistant", "hi"), Utterance("user", "task")]
    )
    result = run(Trial(make_settings(workspace, provider=provider), env))
    assert result.stop_reason == "final_message" and result.turns == 2
    assert env.received[0][0].name == "echo" and env.received[0][0].arguments == {
        "a": 1
    }
    first, second = turn_inputs(workspace["agent"])
    assert first["provider"]["client"]["api"] == (
        "messages" if provider == "anthropic" else "generate_content"
    )
    payload = second["context_payload"]
    if provider == "anthropic":
        roles = [m["role"] for m in payload["messages"]]
        assert roles == ["user", "assistant", "user", "assistant", "user"]
        assert payload["messages"][0]["content"][0]["text"] == "(Start of conversation)"
        assert payload["messages"][3]["content"][0]["type"] == "thinking"
        assert payload["messages"][4]["content"] == [
            {"type": "tool_result", "tool_use_id": "c1", "content": "ok:echo"}
        ]
        assert payload["thinking"] == {"type": "enabled", "budget_tokens": 2048}
        assert payload["tools"][0]["input_schema"] == {"type": "object"}
    else:
        roles = [c["role"] for c in payload["contents"]]
        assert roles == ["user", "model", "user", "model", "user"]
        assert payload["contents"][3]["parts"][1]["thoughtSignature"] == "ts"
        assert payload["contents"][4]["parts"] == [
            {
                "functionResponse": {
                    "name": "echo",
                    "response": {"result": "ok:echo"},
                    "id": "c1",
                }
            }
        ]
        assert payload["systemInstruction"] == {"parts": [{"text": "sys"}]}
        assert payload["tools"][0]["functionDeclarations"][0]["name"] == "echo"
    trajectory = json.loads((workspace["agent"] / "trajectory.json").read_text())
    assert [s["source"] for s in trajectory["steps"]] == [
        "system",
        "agent",
        "user",
        "agent",
        "agent",
    ]
    assert trajectory["steps"][3]["observation"]["results"][0]["content"] == "ok:echo"


def test_usage_totals_and_files(workspace):
    write_script(
        workspace["driver"],
        [{"text": None, "tool_calls": [call("c1", "echo")]}, {"text": "bye"}],
    )
    trial = Trial(make_settings(workspace), MemoryEnvironment())
    run(trial)

    assert not (workspace["agent"] / "usage.json").exists()

    summary = json.loads((workspace["agent"] / "summary.json").read_text())
    assert summary["stop_reason"] == "final_message"
    assert summary["turns"] == 2
    assert summary["provider"] == "openai"
    assert summary["driver"] == {
        "name": "test_driver",
        "version": "0.0.1",
        "engine": "engine-fake",
        "chain": ["engine-fake", "test_driver"],
    }
    state = workspace["agent"] / "driver_state"
    assert (state / "leaf_teardown").read_text() == "leaf\n"
    assert (state / "engine_teardown").exists()
    assert summary["target"]["model"] == "gpt-test"
    assert summary["extra"]["closed"] is True
    assert summary["errors"] == []


def test_atif_trajectory_shape(workspace):
    write_script(
        workspace["driver"],
        [
            {
                "text": "calling",
                "tool_calls": [call("c1", "echo", a=1), call("c2", "echo", b=2)],
            },
            {"text": "bye"},
        ],
    )
    run(Trial(make_settings(workspace), MemoryEnvironment()))
    trajectory = json.loads((workspace["agent"] / "trajectory.json").read_text())

    assert trajectory["schema_version"] == "ATIF-v1.7"
    assert trajectory["agent"]["name"] == "context-cup-runner"
    steps = trajectory["steps"]
    assert [s["step_id"] for s in steps] == [1, 2, 3, 4]
    assert [s["source"] for s in steps] == ["system", "user", "agent", "agent"]
    agent_step = steps[2]
    assert agent_step["message"] == "calling"
    assert [c["tool_call_id"] for c in agent_step["tool_calls"]] == ["c1", "c2"]
    assert agent_step["tool_calls"][0]["arguments"] == {"a": 1}
    assert [r["source_call_id"] for r in agent_step["observation"]["results"]] == [
        "c1",
        "c2",
    ]
    assert TURN_ID.match(agent_step["extra"]["turn_id"])
    assert trajectory["final_metrics"]["total_steps"] == len(trajectory["steps"])


def test_retry_then_success(workspace):
    write_script(workspace["driver"], [{"crash": True}, {"text": "recovered"}])
    trial = Trial(make_settings(workspace, turn_retries=1), MemoryEnvironment())
    result = run(trial)

    assert result.stop_reason == "final_message"
    assert result.turns == 1
    assert len(result.errors) == 1 and "exited 7" in result.errors[0]["error"]
    turn_dirs = sorted(p.name for p in (workspace["agent"] / "turns").iterdir())
    assert [d[:3] for d in turn_dirs] == ["001", "002"]
    assert (
        "boom"
        in (workspace["agent"] / "turns" / turn_dirs[0] / "stderr.txt").read_text()
    )


@pytest.mark.parametrize(
    "steps, expected",
    [
        ([{"crash": True}, {"crash": True}], "exited 7"),
        ([{"no_output": True}, {"no_output": True}], "no output.json"),
        ([{"text": ""}, {"text": ""}], "neither text nor tool calls"),
        (
            [
                {"text": "x", "wrong_turn_id": True},
                {"text": "x", "wrong_turn_id": True},
            ],
            "turn_id",
        ),
    ],
)
def test_retries_exhausted_fail_the_trial(workspace, steps, expected):
    write_script(workspace["driver"], steps)
    env = MemoryEnvironment()
    trial = Trial(make_settings(workspace, turn_retries=1), env)
    with pytest.raises(TrialError, match=expected):
        run(trial)

    assert env.closed_with == "runner_error"
    summary = json.loads((workspace["agent"] / "summary.json").read_text())
    assert summary["stop_reason"] == "runner_error"
    assert len(summary["errors"]) == 2


def test_stop_tool_and_max_steps(workspace):
    write_script(
        workspace["driver"], [{"text": None, "tool_calls": [call("c1", "claim_done")]}]
    )
    result = run(
        Trial(make_settings(workspace), MemoryEnvironment(stop_tools={"claim_done"}))
    )
    assert result.stop_reason == "stop_tool"

    write_script(
        workspace["driver"],
        [{"text": None, "tool_calls": [call(f"c{i}", "echo")]} for i in range(5)],
    )
    result = run(
        Trial(
            make_settings(workspace, max_steps=3, agent_dir=workspace["agent"] / "b"),
            MemoryEnvironment(),
        )
    )
    assert result.stop_reason == "max_steps"
    assert result.turns == 3


def test_user_replies_are_appended(workspace):
    write_script(workspace["driver"], [{"text": "hello"}, {"text": "bye"}])
    env = MemoryEnvironment(stop_on_message=None)
    result = run(Trial(make_settings(workspace, max_steps=2), env))
    assert result.stop_reason == "max_steps"
    inputs = turn_inputs(workspace["agent"])
    items = inputs[1]["context_payload"]["input"]
    assert items[-1] == {"role": "user", "content": "reply"}


def test_tool_output_is_clipped_and_saved(workspace):
    big = "x" * 5000
    write_script(
        workspace["driver"],
        [{"text": None, "tool_calls": [call("c1", "echo")]}, {"text": "bye"}],
    )
    env = MemoryEnvironment(tool_output=big)
    run(Trial(make_settings(workspace, max_tool_output_chars=1000), env))

    inputs = turn_inputs(workspace["agent"])
    content = inputs[1]["context_payload"]["input"][-1]["output"]
    assert content.startswith("x" * 1000 + "\n\n[Tool output clipped")
    assert "of 5005 characters" in content
    saved = workspace["agent"] / "clipped_tool_outputs" / "c1.txt"
    assert saved.read_text() == big + ":echo"


def test_settings_from_env(tmp_path: Path):
    from context_cup_runner.loop import Settings

    (tmp_path / "leaf").mkdir()
    (tmp_path / "leaf" / "package.json").write_text(
        json.dumps({"name": "@context-cup/leaf"})
    )
    env = {
        "CC_TRIAL_ID": "t__1",
        "CC_AGENT_DIR": str(tmp_path),
        "CC_PROXY_URL": "http://proxy.test:1",
        "CC_DRIVER_CHAIN": f"{tmp_path / 'leaf'}",
        "CC_TARGET_JSON": json.dumps(
            {"provider": "gemini", "model": "m", "reasoning_effort": "low"}
        ),
        "CC_MAX_STEPS": "7",
    }
    settings = Settings.from_env(env, default_max_steps=99)
    assert settings.max_steps == 7 and settings.turn_retries == 2
    assert settings.target.reasoning_effort == "low"
    assert settings.proxy_url == "http://proxy.test:1"
    info = settings.provider_info()
    assert info.api_key == "cc-proxy"
    assert info.client.base_url == "http://proxy.test:1/t/t__1/gemini/v1beta"
    script_env = settings.script_env()
    # SDKs append their own version path; OpenAI's base URL carries /v1.
    assert script_env["GOOGLE_GEMINI_BASE_URL"] == "http://proxy.test:1/t/t__1/gemini"
    assert script_env["ANTHROPIC_BASE_URL"] == "http://proxy.test:1/t/t__1/anthropic"
    assert script_env["OPENAI_BASE_URL"] == "http://proxy.test:1/t/t__1/openai/v1"
    assert script_env["GEMINI_API_KEY"] == "cc-proxy"
    info = settings.provider_info()
    assert info.name == "gemini" and info.client.api == "generate_content"
    assert (
        settings.chain.leaf.name == "leaf" and settings.chain.info()["engine"] is None
    )
    del env["CC_MAX_STEPS"]
    assert Settings.from_env(env, default_max_steps=99).max_steps == 99
    with pytest.raises(TrialError, match="CC_TARGET_JSON"):
        Settings.from_env({k: v for k, v in env.items() if k != "CC_TARGET_JSON"})


def test_every_turn_attempt_is_announced_to_the_proxy(workspace, announced):
    write_script(
        workspace["driver"],
        [
            {"crash": True},
            {"text": None, "tool_calls": [call("c1", "echo")]},
            {"text": "bye"},
        ],
    )
    run(Trial(make_settings(workspace, turn_retries=1), MemoryEnvironment()))
    assert [a[:2] for a in announced] == [("http://proxy.test:1", "task-1__abc123")] * 3
    assert all(TURN_ID.match(a[2]) for a in announced)
    assert len({a[2] for a in announced}) == 3, "a retry gets a fresh turn id"
