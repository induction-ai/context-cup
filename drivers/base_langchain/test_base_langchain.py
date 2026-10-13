"""base_langchain's loop end to end: a real MCP server over stdio, the model
scripted. Needs the driver's packages: see the README."""

import asyncio
import importlib.util
import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip(
    "langchain_mcp_adapters", reason="needs the driver's venv: bin/test_agents"
)

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, BaseMessage
from pydantic import Field

spec = importlib.util.spec_from_file_location(
    "base_langchain", Path(__file__).parent / "agent.py"
)
assert spec and spec.loader
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

SERVER = """
import asyncio
import time
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("calc")


@mcp.tool()
def configure_run(seed: int = 0) -> str:
    \"\"\"The harness's, not the model's.\"\"\"
    return "reset"


@mcp.tool()
async def add(a: int, b: int) -> str:
    \"\"\"Add two numbers.\"\"\"
    log = Path(__file__).with_name("calls.log")
    with log.open("a") as f:
        f.write(f"start {time.monotonic()}\\n")
    await asyncio.sleep(0.2)
    with log.open("a") as f:
        f.write(f"end {time.monotonic()}\\n")
    return str(a + b) + " " + "x" * 50


mcp.run()
"""

REPLIES = [
    AIMessage(
        content="",
        tool_calls=[{"id": "c1", "name": "add", "args": {"a": 2, "b": 3}}],
    ),
    AIMessage(content=""),  # blank: asked again
    AIMessage(content="It is 5."),
]


class ScriptedModel(GenericFakeChatModel):
    """A chat model that replies from a script and records what it was sent."""

    sent: list[list[BaseMessage]] = Field(default_factory=list)
    bound: list[Any] = Field(default_factory=list)

    def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
        self.bound.append(tools)
        return self

    def _generate(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> Any:
        self.sent.append(list(messages))
        return super()._generate(messages, *args, **kwargs)


def test_the_agent_works_the_task_with_the_servers_tools(tmp_path, monkeypatch):
    (tmp_path / "server.py").write_text(SERVER)
    (tmp_path / "instruction.md").write_text("Add 2 and 3.")
    servers = [
        {
            "name": "calc",
            "transport": "stdio",
            "command": sys.executable,
            "args": [str(tmp_path / "server.py")],
        }
    ]
    for name, value in {
        "CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "gpt-5.5"}),
        "CC_DRIVER_DIR": str(tmp_path),
        "CC_CONFIG": json.dumps({"max_bytes": 10}),
        "CC_INSTRUCTION_FILE": str(tmp_path / "instruction.md"),
        "CC_MCP_SERVERS_JSON": json.dumps(servers),
        "CC_RESULT_FILE": str(tmp_path / "result.json"),
        "OPENAI_BASE_URL": "http://proxy/t/trial/openai/v1",
        "OPENAI_API_KEY": "cc-proxy",
        "CC_SYSTEM_PROMPT": "Work in /workspace.",
        "CC_HARNESS_TOOLS": "configure_run,record_termination",
    }.items():
        monkeypatch.setenv(name, value)
    replies: Iterator[BaseMessage] = iter(REPLIES)
    scripted = ScriptedModel(messages=replies)
    monkeypatch.setattr(agent, "model", lambda target: scripted)
    assert asyncio.run(agent.main()) == 0

    first = scripted.sent[0]
    assert [m.type for m in first] == ["system", "human"]
    assert first[0].text == "Work in /workspace."
    assert first[1].text == "Add 2 and 3."
    assert [t.name for t in scripted.bound[0]] == ["add"]
    last = scripted.sent[-1][-1]
    assert last.type == "tool" and last.tool_call_id == "c1"
    assert (
        last.content == "5 xxxxxxxx\n\n[truncated by base_langchain: 42 bytes removed]"
    )
    result = json.loads((tmp_path / "result.json").read_text())
    assert result["stop_reason"] == "agent_done"
    assert (result["turns"], result["env_tool_calls"]) == (2, 1)
    assert result["messages"][-1]["data"]["content"] == "It is 5."


def test_the_model_call_limit_ends_the_run(tmp_path, monkeypatch):
    (tmp_path / "server.py").write_text(SERVER)
    (tmp_path / "instruction.md").write_text("Add 2 and 3, forever.")
    servers = [
        {
            "name": "calc",
            "transport": "stdio",
            "command": sys.executable,
            "args": [str(tmp_path / "server.py")],
        }
    ]
    for name, value in {
        "CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "gpt-5.5"}),
        "CC_CONFIG": "{}",
        "CC_MAX_STEPS": "2",
        "CC_INSTRUCTION_FILE": str(tmp_path / "instruction.md"),
        "CC_MCP_SERVERS_JSON": json.dumps(servers),
        "CC_RESULT_FILE": str(tmp_path / "result.json"),
    }.items():
        monkeypatch.setenv(name, value)

    def forever() -> Iterator[BaseMessage]:
        n = 0
        while True:
            n += 1
            yield AIMessage(
                content="",
                tool_calls=[{"id": f"c{n}", "name": "add", "args": {"a": n, "b": n}}],
            )

    scripted = ScriptedModel(messages=forever())
    monkeypatch.setattr(agent, "model", lambda target: scripted)
    assert asyncio.run(agent.main()) == 0

    result = json.loads((tmp_path / "result.json").read_text())
    assert result["stop_reason"] == "max_steps"
    assert (result["turns"], result["env_tool_calls"]) == (2, 2)
    assert len(scripted.sent) == 2


def calls_ran_in_order(tmp_path: Path) -> bool:
    """The server's log: a call's end before the next call's start."""
    kinds = [
        line.split()[0]
        for line in (tmp_path / "calls.log").read_text().split("\n")
        if line
    ]
    return len(kinds) >= 4 and kinds == ["start", "end"] * (len(kinds) // 2)


def test_a_turns_tool_calls_run_one_at_a_time(tmp_path, monkeypatch):
    (tmp_path / "server.py").write_text(SERVER)
    (tmp_path / "instruction.md").write_text("Add 1 and 1, and 2 and 2.")
    servers = [
        {
            "name": "calc",
            "transport": "stdio",
            "command": sys.executable,
            "args": [str(tmp_path / "server.py")],
        }
    ]
    for name, value in {
        "CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "gpt-5.5"}),
        "CC_CONFIG": "{}",
        "CC_INSTRUCTION_FILE": str(tmp_path / "instruction.md"),
        "CC_MCP_SERVERS_JSON": json.dumps(servers),
        "CC_RESULT_FILE": str(tmp_path / "result.json"),
    }.items():
        monkeypatch.setenv(name, value)
    replies: Iterator[BaseMessage] = iter(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {"id": "c1", "name": "add", "args": {"a": 1, "b": 1}},
                    {"id": "c2", "name": "add", "args": {"a": 2, "b": 2}},
                ],
            ),
            AIMessage(content="Done."),
        ]
    )
    scripted = ScriptedModel(messages=replies)
    monkeypatch.setattr(agent, "model", lambda target: scripted)
    assert asyncio.run(agent.main()) == 0

    assert calls_ran_in_order(tmp_path)
    result = json.loads((tmp_path / "result.json").read_text())
    assert (result["turns"], result["env_tool_calls"]) == (2, 2)


def test_clip_leaves_small_results_alone():
    assert agent.clip("short", 10) == "short"
    assert agent.clip("x" * 12, 10) == "x" * 10 + agent.MARKER.format(dropped=2)
