"""Pure parts of the environments: prompt building, bundle parsing, and the
host agents' settings, with harbor stubbed out."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest
from context_cup_runner.envs.tau3 import extract_policy, is_user_stop, system_prompt
from context_cup_runner.envs.toolathlon import (
    bundle_stop_tools,
    bundle_system_prompt,
    read_bundle,
)


def test_policy_extraction_prefers_trailing_block():
    text = "<instructions>do x</instructions>\n<policy>\nBe nice.\n</policy>\n"
    assert extract_policy(text) == "Be nice."
    assert extract_policy("<policy>a</policy> stuff <policy>b</policy>") == "b"
    assert extract_policy("no tags") == "no tags"
    prompt = system_prompt("Be nice.")
    assert prompt.startswith("<instructions>") and prompt.endswith(
        "<policy>\nBe nice.\n</policy>"
    )
    assert is_user_stop("thanks ###STOP###") and not is_user_stop("hello")


def test_bundle_parsing(tmp_path: Path):
    bundle = tmp_path / "b.json"
    assert read_bundle(bundle) == {}
    assert bundle_stop_tools({}) == ["local-claim_done"]
    assert bundle_system_prompt({}) is None
    bundle.write_text(
        json.dumps(
            {"system_prompts": {"agent": "SP"}, "stop": {"tool_names": ["done", 3]}}
        )
    )
    data = read_bundle(bundle)
    assert bundle_system_prompt(data) == "SP"
    assert bundle_stop_tools(data) == ["done"]


def _stub_harbor(monkeypatch):
    """Enough of harbor for the host modules to import."""

    class BaseInstalledAgent:
        def __init__(self, logs_dir, *args, extra_env=None, mcp_servers=None, **kwargs):
            self.logs_dir = Path(logs_dir)
            self._extra_env = dict(extra_env or {})
            self._version = None
            self.mcp_servers = mcp_servers or []

        def _get_env(self, key):
            return self._extra_env.get(key)

    modules = {
        "harbor": types.ModuleType("harbor"),
        "harbor.agents": types.ModuleType("harbor.agents"),
        "harbor.agents.installed": types.ModuleType("harbor.agents.installed"),
        "harbor.agents.installed.base": types.ModuleType(
            "harbor.agents.installed.base"
        ),
        "harbor.agents.capabilities": types.ModuleType("harbor.agents.capabilities"),
        "harbor.environments": types.ModuleType("harbor.environments"),
        "harbor.environments.base": types.ModuleType("harbor.environments.base"),
        "harbor.models": types.ModuleType("harbor.models"),
        "harbor.models.agent": types.ModuleType("harbor.models.agent"),
        "harbor.models.agent.context": types.ModuleType("harbor.models.agent.context"),
    }
    modules["harbor.agents.installed.base"].BaseInstalledAgent = BaseInstalledAgent

    class AgentCapabilities:
        def __init__(self, **kwargs: object) -> None:
            self.kwargs = kwargs

    modules["harbor.agents.capabilities"].AgentCapabilities = AgentCapabilities
    modules["harbor.environments.base"].BaseEnvironment = object
    modules["harbor.models.agent.context"].AgentContext = object
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    for name in list(sys.modules):
        if name.startswith("context_cup_runner.host") or name in (
            "context_cup_runner.container",
            "context_cup_runner.tau3",
            "context_cup_runner.toolathlon",
        ):
            monkeypatch.delitem(sys.modules, name)


def test_host_agent_env_and_tau3_seed(monkeypatch, tmp_path: Path):
    _stub_harbor(monkeypatch)
    from context_cup_runner.tau3 import Tau3Agent

    server = types.SimpleNamespace(
        name="rt", transport="streamable-http", url="http://127.0.0.1:9000/mcp"
    )
    logs = tmp_path / "job" / "tau3-banking-1__abc123" / "agent"
    engine, leaf = tmp_path / "python", tmp_path / "base_x"
    for d in (engine, leaf):
        d.mkdir()
    (engine / "setup.sh").write_text("true\n")
    (leaf / "node_modules").mkdir()
    (leaf / "node_modules" / "x.js").write_text("")
    (leaf / "run.sh").write_text("true\n")
    extra = {
        "CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "m"}),
        "CC_HOST_DRIVER_CHAIN": f"{engine}:{leaf}",
        "CC_MAX_STEPS": "5",
    }
    agent = Tau3Agent(logs, extra_env=extra, mcp_servers=[server])

    env = agent._loop_env(None)
    assert env["CC_BENCHMARK"] == "tau3"
    assert env["CC_TRIAL_ID"] == "tau3-banking-1__abc123"
    assert env["CC_TAU3_MCP_URL"] == server.url
    # The proxy runs in the container; the loop never sees a key.
    assert env["CC_PROXY_URL"] == "http://127.0.0.1:18080"
    assert "OPENAI_API_KEY" not in env and env["CC_MAX_STEPS"] == "5"
    assert "CC_DRIVER_USER" not in env  # until install has made the user
    agent._driver_drop = "setpriv"
    env = agent._loop_env(None)
    assert (env["CC_DRIVER_USER"], env["CC_DRIVER_DROP"]) == ("ccdriver", "setpriv")
    assert (
        env["CC_DRIVER_CHAIN"]
        == "/installed-agent/chain/00_python:/installed-agent/chain/01_base_x"
    )
    script_env = agent.script_env(agent.host_chain(), 0)
    assert script_env["CC_SELF_DIR"] == "/installed-agent/chain/00_python"
    assert script_env["CC_DRIVER_DIR"] == "/installed-agent/chain/01_base_x"
    assert script_env["CC_STATE_DIR"] == "/logs/agent/driver_state"
    staged = agent.stage_package(leaf, 1)
    assert (staged / "run.sh").exists() and not (staged / "node_modules").exists()

    seed_a = agent.trial_seed()
    assert agent.trial_seed() == seed_a
    other = Tau3Agent(
        tmp_path / "job" / "tau3-banking-1__zzz999" / "agent",
        extra_env=extra,
        mcp_servers=[server],
    )
    assert other.trial_seed() != seed_a


def test_toolathlon_agent_settings(monkeypatch, tmp_path: Path):
    _stub_harbor(monkeypatch)
    from context_cup_runner.toolathlon import ToolathlonAgent

    server = types.SimpleNamespace(
        name="gw",
        transport="sse",
        url="http://127.0.0.1:8765/sse",
        command=None,
        args=[],
    )
    (tmp_path / "leaf").mkdir()
    extra = {
        "CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "m"}),
        "CC_HOST_DRIVER_CHAIN": str(tmp_path / "leaf"),
    }
    agent = ToolathlonAgent(
        tmp_path / "t__1" / "agent", extra_env=extra, mcp_servers=[server]
    )
    env = agent._loop_env(None)
    assert env["CC_BENCHMARK"] == "toolathlon"
    assert json.loads(env["CC_MCP_SERVERS_JSON"])[0]["url"] == server.url


def test_uv_target_triple_maps_architectures():
    from context_cup_runner.uv_bootstrap import uv_target_triple

    assert uv_target_triple("x86_64", "gnu") == "x86_64-unknown-linux-gnu"
    assert uv_target_triple("aarch64", "musl") == "aarch64-unknown-linux-musl"
    assert uv_target_triple("arm64", "gnu") == "aarch64-unknown-linux-gnu"
    import pytest

    with pytest.raises(ValueError, match="riscv64"):
        uv_target_triple("riscv64", "gnu")


def test_node_platform_maps_architectures_and_libc():
    from context_cup_runner.node_bootstrap import node_platform, node_release_url

    assert node_platform("x86_64", "gnu") == "linux-x64"
    assert node_platform("aarch64", "gnu") == "linux-arm64"
    assert node_platform("amd64", "musl") == "linux-x64-musl"
    assert node_release_url("linux-arm64", "24.0.0") == (
        "https://nodejs.org/dist/v24.0.0/node-v24.0.0-linux-arm64.tar.xz"
    )
    assert node_release_url("linux-x64-musl", "24.0.0").startswith(
        "https://unofficial-builds.nodejs.org/download/release/v24.0.0/"
    )
    with pytest.raises(ValueError, match="riscv64"):
        node_platform("riscv64", "gnu")


def test_proxy_command_and_keys_file(monkeypatch):
    _stub_harbor(monkeypatch)
    from context_cup_runner.container import keys_file_text, proxy_command

    argv = proxy_command(
        target={"provider": "anthropic", "model": "claude-x"}, save_bodies=True
    )
    assert argv[:2] == [
        "/installed-agent/.node/node",
        "/installed-agent/.proxy/proxy.cjs",
    ]
    assert argv[argv.index("--port") + 1] == "18080"
    assert argv[argv.index("--calls") + 1] == "/logs/agent/calls.jsonl"
    assert argv[argv.index("--save-bodies") + 1] == "/logs/agent/bodies"
    assert argv[-4:] == [
        "--default-provider",
        "anthropic",
        "--default-model",
        "claude-x",
    ]
    assert "--save-bodies" not in proxy_command(target=None, save_bodies=False)
    # Values are quoted for `.`, so a key with shell characters survives.
    assert keys_file_text({"OPENAI_API_KEY": "sk-a$b'c"}) == (
        "OPENAI_API_KEY='sk-a$b'\"'\"'c'\n"
    )


def test_drop_argv_per_tool():
    from context_cup_runner.chain import drop_argv

    argv = ["bash", "/x/run.sh", "in.json"]
    assert drop_argv("setpriv", "ccdriver", 999, 998, argv) == [
        "setpriv",
        "--reuid=999",
        "--regid=998",
        "--clear-groups",
        *argv,
    ]
    assert drop_argv("runuser", "ccdriver", 999, 998, argv) == [
        "runuser",
        "-u",
        "ccdriver",
        "--",
        *argv,
    ]
    assert drop_argv("su", "ccdriver", 999, 998, argv) == [
        "su",
        "-s",
        "/bin/sh",
        "-c",
        "bash /x/run.sh in.json",
        "ccdriver",
    ]
    with pytest.raises(ValueError, match="sudo"):
        drop_argv("sudo", "ccdriver", 999, 998, argv)
