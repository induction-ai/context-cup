"""The Codex wrapper stamps the per-trial proxy route and forwards the
target's reasoning effort, with harbor's Codex stubbed out."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest


def _stub_harbor_codex(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    seen: dict[str, object] = {}

    class Codex:
        def __init__(self, logs_dir, *args, extra_env=None, **kwargs):
            self.logs_dir = Path(logs_dir)
            self._extra_env = dict(extra_env or {})
            seen["kwargs"] = dict(kwargs)
            seen["installed"] = False

        async def install(self, environment):
            seen["installed"] = True
            seen["env_at_install"] = dict(self._extra_env)

    modules = {
        "harbor": types.ModuleType("harbor"),
        "harbor.agents": types.ModuleType("harbor.agents"),
        "harbor.agents.installed": types.ModuleType("harbor.agents.installed"),
        "harbor.agents.installed.codex": types.ModuleType(
            "harbor.agents.installed.codex"
        ),
        "harbor.environments": types.ModuleType("harbor.environments"),
        "harbor.environments.base": types.ModuleType("harbor.environments.base"),
    }
    modules["harbor.agents.installed.codex"].Codex = Codex  # type: ignore[attr-defined]
    modules["harbor.environments.base"].BaseEnvironment = object  # type: ignore[attr-defined]
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.delitem(sys.modules, "context_cup_runner.codex", raising=False)
    return seen


def test_routes_each_trial_through_its_own_proxy_prefix(monkeypatch, tmp_path):
    import asyncio

    seen = _stub_harbor_codex(monkeypatch)
    from context_cup_runner.codex import CodexAgent

    logs = tmp_path / "job" / "tau3-banking-1__abc123" / "agent"
    agent = CodexAgent(
        logs,
        extra_env={
            "CC_PROXY_URL": "http://host.docker.internal:6123/",
            "CC_TARGET_JSON": json.dumps(
                {"provider": "openai", "model": "gpt-5.5", "reasoning_effort": "high"}
            ),
        },
    )
    assert seen["kwargs"] == {"reasoning_effort": "high"}
    asyncio.run(agent.install(object()))
    env = seen["env_at_install"]
    assert isinstance(env, dict)
    assert (
        env["OPENAI_BASE_URL"]
        == "http://host.docker.internal:6123/t/tau3-banking-1__abc123/openai/v1"
    )
    assert env["OPENAI_API_KEY"] == "cc-proxy"
    assert seen["installed"] is True


def test_without_a_proxy_the_agent_refuses_to_install(monkeypatch, tmp_path):
    import asyncio

    _stub_harbor_codex(monkeypatch)
    from context_cup_runner.codex import CodexAgent

    agent = CodexAgent(tmp_path / "t__1" / "agent", extra_env={})
    with pytest.raises(RuntimeError, match="CC_PROXY_URL"):
        asyncio.run(agent.install(object()))


def test_no_reasoning_effort_means_no_kwarg(monkeypatch, tmp_path):
    seen = _stub_harbor_codex(monkeypatch)
    from context_cup_runner.codex import CodexAgent

    CodexAgent(
        tmp_path / "t__1" / "agent",
        extra_env={"CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "m"})},
    )
    assert seen["kwargs"] == {}
