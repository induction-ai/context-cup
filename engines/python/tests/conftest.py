import json
from pathlib import Path

import pytest
from context_cup_engine.protocol import (
    Dirs,
    ProviderClient,
    ProviderInfo,
    Target,
    TurnInput,
)

OPENAI = ProviderInfo(
    name="openai",
    api_key="cc-proxy",
    client=ProviderClient(
        base_url="http://proxy.test:1/t/trial-1/openai/v1", api="responses"
    ),
)


def openai_payload() -> dict:
    return {
        "model": "gpt-5.5",
        "instructions": "be brief",
        "input": [{"role": "user", "content": "hello"}],
        "tools": [
            {
                "type": "function",
                "name": "get_balance",
                "description": "balance",
                "parameters": {"type": "object", "properties": {}},
            }
        ],
        "reasoning": {"effort": "low"},
        "store": False,
        "include": ["reasoning.encrypted_content"],
    }


@pytest.fixture
def turn_input(tmp_path: Path) -> TurnInput:
    turn_dir = tmp_path / "turns" / "001_abc123"
    turn_dir.mkdir(parents=True)
    return TurnInput(
        trial_id="trial-1",
        turn_id="001_abc123",
        turn_index=1,
        first=True,
        provider=OPENAI,
        target=Target(model="gpt-5.5", reasoning_effort="low"),
        context_payload=openai_payload(),
        original_payload=openai_payload(),
        state=None,
        dirs=Dirs(turn=str(turn_dir), state=str(tmp_path / "state")),
    )


def write_driver(
    directory: Path, name: str, body: str, config: dict | None = None
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = {
        "name": f"@context-cup-drivers/{name}",
        "version": "t",
        "contextCup": {"kind": "driver", "extends": "@context-cup/engine-python"},
    }
    if config:
        manifest["contextCup"]["config"] = config
    (directory / "package.json").write_text(json.dumps(manifest))
    (directory / "driver.py").write_text(body)
    return directory
