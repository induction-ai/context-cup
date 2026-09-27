"""The runner and the Python engines share one implementation of the protocol
(course/protocol), and the TypeScript engines share its twin in the same
package, so what is left to check is the boundary between the languages, and
one runner-built input.json surviving the trip through JSON."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import get_args

import pytest

import context_cup_protocol as protocol
import context_cup_runner.protocol as runner_protocol

ROOT = Path(__file__).resolve().parents[1]


def ts_list(name: str, file: str = "course/shared/src/provider.ts") -> set[str]:
    source = (ROOT / file).read_text()
    match = re.search(rf"{name} = (\[.*?\]) as const", source, re.DOTALL)
    assert match, name
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def test_typescript_and_python_agree_on_providers_and_wires() -> None:
    assert ts_list("PROVIDERS") == set(get_args(protocol.Provider))
    assert ts_list("WIRES") == set(get_args(protocol.Wire))
    assert ts_list("PROVIDERS", "course/protocol/src/models.ts") == set(
        get_args(protocol.Provider)
    )


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


def test_the_typescript_view_reads_payloads_as_the_python_one_does() -> None:
    tsx = ROOT / "node_modules/.bin/tsx"
    if not tsx.exists():
        pytest.skip("pnpm install has not run")
    fixtures = json.loads(
        (ROOT / "course/protocol/tests/view_fixtures.json").read_text()
    )
    # A structured Gemini result, which both views render as Python's json.dumps.
    fixtures["gemini"]["contents"][4]["parts"][1]["functionResponse"]["response"] = {
        "rows": [1, {"a": "é"}],
        "ok": True,
    }
    out = subprocess.run(
        [str(tsx), str(ROOT / "tests/view_dump.ts")],
        input=json.dumps(fixtures),
        capture_output=True,
        text=True,
        check=True,
    )
    typescript = json.loads(out.stdout)
    for provider, payload in fixtures.items():
        conversation = protocol.view(provider, payload)
        assert typescript[provider] == {
            "system": conversation.system,
            "tools": [t.model_dump() for t in conversation.tools],
            "messages": [
                {
                    "role": m.role,
                    "text": m.text,
                    "toolCalls": [c.model_dump() for c in m.tool_calls],
                    "toolCallId": m.tool_call_id,
                    "opaque": m.opaque,
                }
                for m in conversation.messages
            ],
        }, provider


def test_both_languages_read_every_manifest_alike(tmp_path: Path) -> None:
    """The suite and TypeScript engines read manifests with manifest.ts, the
    runner and Python engines with manifest.py: every package in the repo,
    and the edge cases, must read the same through both."""
    tsx = ROOT / "node_modules/.bin/tsx"
    if not tsx.exists():
        pytest.skip("pnpm install has not run")
    cases = {
        "toml_only": {
            "pyproject.toml": '[project]\nname = "ignored"\nversion = "2.0"\n'
            'description = "From TOML."\ndependencies = []\n'
            '[tool.context-cup]\nkind = "driver"\nextends = "python"\n'
            'providers = ["openai"]\n[tool.context-cup.config]\nmax_bytes = 100_000\n'
        },
        "both": {
            "package.json": json.dumps(
                {"version": "1", "contextCup": {"kind": "agent", "config": {"k": 1}}}
            ),
            "pyproject.toml": '[tool.context-cup]\nkind = "driver"\n',
        },
        "json_without_block": {
            "package.json": json.dumps({"name": "x"}),
            "pyproject.toml": '[project]\nversion = "3"\n[tool.context-cup]\nkind = "engine"\n',
        },
        "neither": {"pyproject.toml": '[project]\nname = "plain"\n'},
        "tool_not_a_table": {"pyproject.toml": 'tool = "not a table"\n'},
        "project_not_a_table": {
            "pyproject.toml": 'project = 1\n[tool.context-cup]\nkind = "driver"\n'
        },
    }
    for name, files in cases.items():
        (tmp_path / name).mkdir()
        for file, text in files.items():
            (tmp_path / name / file).write_text(text)
    real = [
        d
        for group in ("course", "engines", "drivers")
        for d in sorted((ROOT / group).iterdir())
        if d.is_dir()
    ]
    dirs = [str(d) for d in [*real, *(tmp_path / n for n in cases)]]
    out = subprocess.run(
        [str(tsx), str(ROOT / "tests/manifest_dump.ts")],
        input=json.dumps(dirs),
        capture_output=True,
        text=True,
        check=True,
    )
    typescript = json.loads(out.stdout)
    for d in dirs:
        manifest = protocol.read_manifest(Path(d))
        python = (
            None
            if manifest is None
            else {
                k: v
                for k, v in {
                    "settings": manifest.settings,
                    "version": manifest.version,
                    "description": manifest.description,
                }.items()
                if v is not None
            }
        )
        assert typescript[d] == python, d
    assert typescript[str(tmp_path / "both")]["settings"]["kind"] == "agent"
    assert typescript[str(tmp_path / "json_without_block")]["version"] == "3"
    assert typescript[str(tmp_path / "neither")] is None
    assert typescript[str(tmp_path / "tool_not_a_table")] is None
    assert typescript[str(tmp_path / "project_not_a_table")] == {
        "settings": {"kind": "driver"}
    }
    assert (
        typescript[str(ROOT / "drivers/base_python")]["settings"]["extends"] == "python"
    )
