"""The Codex wrapper starts the in-container proxy, stamps the per-trial
route, and forwards the target's reasoning effort, with harbor's Codex and
the container calls stubbed out."""

from __future__ import annotations

import importlib
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

        async def run(self, instruction, environment, context):
            seen["ran"] = instruction

    modules = {
        "harbor": types.ModuleType("harbor"),
        "harbor.agents": types.ModuleType("harbor.agents"),
        "harbor.agents.installed": types.ModuleType("harbor.agents.installed"),
        "harbor.agents.installed.base": types.ModuleType(
            "harbor.agents.installed.base"
        ),
        "harbor.agents.installed.codex": types.ModuleType(
            "harbor.agents.installed.codex"
        ),
        "harbor.environments": types.ModuleType("harbor.environments"),
        "harbor.environments.base": types.ModuleType("harbor.environments.base"),
        "harbor.models": types.ModuleType("harbor.models"),
        "harbor.models.agent": types.ModuleType("harbor.models.agent"),
        "harbor.models.agent.context": types.ModuleType("harbor.models.agent.context"),
    }
    modules["harbor.agents.installed.base"].BaseInstalledAgent = object  # type: ignore[attr-defined]
    modules["harbor.agents.installed.codex"].Codex = Codex  # type: ignore[attr-defined]
    modules["harbor.environments.base"].BaseEnvironment = object  # type: ignore[attr-defined]
    modules["harbor.models.agent.context"].AgentContext = object  # type: ignore[attr-defined]
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    for name in ("context_cup_runner.codex", "context_cup_runner.container"):
        monkeypatch.delitem(sys.modules, name, raising=False)

    # A fresh import: the package attribute may still hold a stubbed-out copy.
    codex = importlib.import_module("context_cup_runner.codex")

    async def probe_platform(agent, environment):
        return ("aarch64", "gnu")

    async def start_proxy(agent, environment, **kwargs):
        seen["proxy"] = kwargs

    async def wait_for_proxy(agent, environment):
        seen.setdefault("events", []).append("wait")  # type: ignore[union-attr]

    async def stop_proxy(agent, environment):
        seen.setdefault("events", []).append("stop")  # type: ignore[union-attr]

    for fn in (probe_platform, start_proxy, wait_for_proxy, stop_proxy):
        monkeypatch.setattr(codex, fn.__name__, fn)
    return seen


def test_routes_each_trial_through_its_own_proxy_prefix(monkeypatch, tmp_path):
    import asyncio

    seen = _stub_harbor_codex(monkeypatch)
    from context_cup_runner.codex import CodexAgent

    logs = tmp_path / "job" / "tau3-banking-1__abc123" / "agent"
    agent = CodexAgent(
        logs,
        extra_env={
            "CC_SAVE_BODIES": "1",
            "CC_TARGET_JSON": json.dumps(
                {"provider": "openai", "model": "gpt-5.5", "reasoning_effort": "high"}
            ),
        },
    )
    assert seen["kwargs"] == {"reasoning_effort": "high"}
    asyncio.run(agent.install(object()))
    env = seen["env_at_install"]
    assert isinstance(env, dict)
    # The proxy is in the container, on loopback; Codex holds a placeholder.
    assert (
        env["OPENAI_BASE_URL"]
        == "http://127.0.0.1:18080/t/tau3-banking-1__abc123/openai/v1"
    )
    assert env["OPENAI_API_KEY"] == "cc-proxy"
    assert seen["installed"] is True
    proxy = seen["proxy"]
    assert isinstance(proxy, dict)
    assert proxy["platform"] == ("aarch64", "gnu")
    assert proxy["target"]["model"] == "gpt-5.5"
    assert proxy["save_bodies"] is True


def test_the_proxy_is_stopped_after_codex_runs(monkeypatch, tmp_path):
    import asyncio

    seen = _stub_harbor_codex(monkeypatch)
    from context_cup_runner.codex import CodexAgent

    agent = CodexAgent(tmp_path / "t__1" / "agent", extra_env={})
    asyncio.run(agent.run("do it", object(), object()))
    assert seen["ran"] == "do it"
    assert seen["events"] == ["wait", "stop"]


def test_no_reasoning_effort_means_no_kwarg(monkeypatch, tmp_path):
    seen = _stub_harbor_codex(monkeypatch)
    from context_cup_runner.codex import CodexAgent

    CodexAgent(
        tmp_path / "t__1" / "agent",
        extra_env={"CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "m"})},
    )
    assert seen["kwargs"] == {}
