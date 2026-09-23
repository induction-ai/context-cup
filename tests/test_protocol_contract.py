"""The runner and the engines share one Python implementation of the
protocol (course/protocol), so what is left to check is the boundary with
TypeScript, and one runner-built input.json surviving the trip through JSON."""

from __future__ import annotations

import re
from pathlib import Path
from typing import get_args

import context_cup_protocol as protocol
import context_cup_runner.protocol as runner_protocol

ROOT = Path(__file__).resolve().parents[1]


def ts_list(name: str) -> set[str]:
    source = (ROOT / "course/shared/src/provider.ts").read_text()
    match = re.search(rf"{name} = (\[.*?\]) as const", source, re.DOTALL)
    assert match, name
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def test_typescript_and_python_agree_on_providers_and_wires() -> None:
    assert ts_list("PROVIDERS") == set(get_args(protocol.Provider))
    assert ts_list("WIRES") == set(get_args(protocol.Wire))


def test_a_runner_built_input_is_what_the_engine_reads() -> None:
    adapter = protocol.adapter_for("openai")
    payload = adapter.initial_payload(
        model="gpt-5.5",
        system="be brief",
        opening=[protocol.Utterance("user", "hello")],
        tools=[{"type": "function", "function": {"name": "echo", "parameters": {}}}],
        reasoning_effort="low",
    )
    turn = protocol.TurnInput(
        trial_id="t__1",
        turn_id="001_abcdef",
        turn_index=1,
        first=True,
        provider=protocol.ProviderInfo(
            name="openai",
            api_key=protocol.PLACEHOLDER_KEY,
            client=runner_protocol.proxy_client(
                "http://proxy.test:1", "t__1", "openai"
            ),
        ),
        target=protocol.Target(model="gpt-5.5", reasoning_effort="low"),
        context_payload=payload,
        original_payload=payload,
        dirs=protocol.Dirs(turn="/t", state="/s"),
    )
    parsed = protocol.TurnInput.model_validate_json(turn.model_dump_json())
    assert parsed == turn
    assert parsed.provider.client.base_url == "http://proxy.test:1/t/t__1/openai/v1"
