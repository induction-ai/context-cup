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
        def __init__(self, logs_dir, *args, extra_env=None, mcp_servers=None, **kwargs):
            self.logs_dir = Path(logs_dir)
            self._extra_env = dict(extra_env or {})
            self.mcp_servers = list(mcp_servers or [])
            seen["kwargs"] = dict(kwargs)
            seen["installed"] = False

        async def install(self, environment):
            seen["installed"] = True
            seen["env_at_install"] = dict(self._extra_env)

        async def exec_as_agent(self, environment, command):
            seen.setdefault("commands", []).append(command)  # type: ignore[union-attr]

        async def exec_as_root(self, environment, command):
            return types.SimpleNamespace(stdout=seen.get("agent_prompt", ""))

        def _build_effective_config(self, openai_base_url=None):
            # harbor writes an SSE server as a bare url, which Codex can't use.
            return {
                "mcp_servers": {
                    s.name: (
                        {"command": s.command, "args": list(s.args)}
                        if s.transport == "stdio"
                        else {"url": s.url}
                    )
                    for s in self.mcp_servers
                }
            }

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
    assert seen["kwargs"] == {"reasoning_effort": "high", "version": "0.156.1"}
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
    assert seen["kwargs"] == {"version": "0.156.1"}


def test_sse_servers_are_bridged_through_mcp_remote_and_all_required(
    monkeypatch, tmp_path
):
    import asyncio

    seen = _stub_harbor_codex(monkeypatch)
    from context_cup_runner.codex import MCP_REMOTE_COMMAND, CodexAgent

    gateway = types.SimpleNamespace(
        name="gw", transport="sse", url="http://127.0.0.1:8765/sse"
    )
    local = types.SimpleNamespace(
        name="fs", transport="stdio", command="fs-server", args=["--root", "/w"]
    )
    agent = CodexAgent(
        tmp_path / "t__1" / "agent", extra_env={}, mcp_servers=[gateway, local]
    )
    config = agent._build_effective_config()
    assert config["mcp_servers"] == {
        "gw": {
            "command": MCP_REMOTE_COMMAND,
            "args": [gateway.url, "--transport", "sse-only", "--allow-http"],
            "required": True,
        },
        "fs": {"command": "fs-server", "args": ["--root", "/w"], "required": True},
    }
    asyncio.run(agent.install(object()))
    commands = seen["commands"]
    assert isinstance(commands, list) and len(commands) == 1
    assert "mcp-remote@0.14.3" in commands[0]


def test_no_sse_server_means_no_mcp_remote_install(monkeypatch, tmp_path):
    import asyncio

    seen = _stub_harbor_codex(monkeypatch)
    from context_cup_runner.codex import CodexAgent

    asyncio.run(CodexAgent(tmp_path / "t__1" / "agent", extra_env={}).install(object()))
    assert "commands" not in seen


def test_codex_gets_the_benchmark_agent_prompt_when_the_task_has_one(
    monkeypatch, tmp_path
):
    import asyncio

    seen = _stub_harbor_codex(monkeypatch)
    from context_cup_runner.codex import CodexAgent

    agent = CodexAgent(tmp_path / "t__1" / "agent", extra_env={})
    asyncio.run(agent.run("the task", object(), object()))
    assert seen["ran"] == "the task"
    seen["agent_prompt"] = "Workspace: /w\n\n# Task\nthe task\n"
    asyncio.run(agent.run("the task", object(), object()))
    assert seen["ran"] == "Workspace: /w\n\n# Task\nthe task"
