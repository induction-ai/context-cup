"""The runner writes input.json and reads output.json; the engine does the
reverse. Both sides carry their own models of the same protocol, so check
they agree on real instances rather than by inspection."""

from __future__ import annotations

import json
from pathlib import Path

import context_cup_engine.protocol as engine_protocol
import context_cup_runner.protocol as runner_protocol
from context_cup_runner.providers.registry import adapter_for


def runner_input() -> dict:
    """An input.json as the runner produces it, straight from its models."""
    adapter = adapter_for("openai")
    payload = adapter.initial_payload(
        model="gpt-5.5",
        system="be brief",
        opening=[runner_protocol_utterance("user", "hello")],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "echo",
                    "description": "echo",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        reasoning_effort="low",
    )
    turn = runner_protocol.TurnInput(
        trial_id="t__1",
        turn_id="001_abcdef",
        turn_index=1,
        first=True,
        provider=runner_protocol.ProviderInfo(
            name="openai",
            api_key="sk-test",
            client=runner_protocol.PROVIDER_CLIENTS["openai"],
        ),
        target=runner_protocol.TargetSpec(model="gpt-5.5", reasoning_effort="low"),
        context_payload=payload,
        original_payload=payload,
        state=None,
        limits={"max_steps": 5},
        dirs=runner_protocol.Dirs(turn="/t", state="/s", workspace=None),
    )
    return json.loads(turn.model_dump_json())


def runner_protocol_utterance(role: str, text: str):
    from context_cup_runner.providers.base import Utterance

    return Utterance(role, text)  # type: ignore[arg-type]


def test_runner_input_validates_in_the_engine():
    data = runner_input()
    parsed = engine_protocol.TurnInput.model_validate(data)
    assert parsed.protocol == 2 and parsed.first is True
    assert (
        parsed.provider.name == "openai" and parsed.provider.client.api == "responses"
    )
    assert parsed.context_payload["model"] == "gpt-5.5"
    assert parsed.context_payload["tools"][0]["name"] == "echo"


def test_engine_output_validates_in_the_runner():
    output = engine_protocol.TurnOutput(
        turn_id="001_abcdef",
        response={
            "id": "resp_1",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "hi"}],
                }
            ],
        },
        context_payload={"model": "gpt-5.5", "input": []},
        state={"n": 1},
        calls=[
            engine_protocol.ModelCall(
                provider="openai",
                host="api.openai.com",
                model="gpt-5.5",
                wire="responses",
                usage=engine_protocol.Usage(input=10, output=2),
            )
        ],
        driver=engine_protocol.DriverInfo(name="base_passthrough", engine="python"),
    )
    raw = json.loads(output.model_dump_json(exclude_none=True))
    parsed, extracted = runner_protocol.validate_output(
        raw, "001_abcdef", adapter_for("openai")
    )
    assert extracted.text == "hi" and not extracted.tool_calls
    assert parsed.state == {"n": 1}
    assert (
        parsed.calls[0].usage.input == 10 and parsed.calls[0].host == "api.openai.com"
    )


def test_both_sides_agree_on_provider_literals():
    assert set(engine_protocol.Provider.__args__) == set(
        runner_protocol.Provider.__args__
    )
    assert set(engine_protocol.Wire.__args__) == set(runner_protocol.Wire.__args__)


def test_shared_ts_provider_list_matches(tmp_path: Path):
    ts = (
        Path(__file__).resolve().parents[1] / "course/shared/src/provider.ts"
    ).read_text()
    listed = set(json.loads(ts.split("PROVIDERS = ")[1].split(" as const")[0]))
    assert listed == set(engine_protocol.Provider.__args__)
