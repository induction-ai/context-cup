"""base_llamaindex's loop end to end: a real MCP server over stdio, the model
scripted. Needs the driver's packages: see the README."""

import asyncio
import importlib.util
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip(
    "llama_index.tools.mcp", reason="needs the driver's venv: bin/test_agents"
)

from llama_index.core.base.llms.types import (
    ChatMessage,
    ChatResponse,
    LLMMetadata,
    MessageRole,
)
from llama_index.core.llms.function_calling import FunctionCallingLLM
from llama_index.core.llms.llm import ToolSelection
from pydantic import Field

spec = importlib.util.spec_from_file_location(
    "base_llamaindex", Path(__file__).parent / "agent.py"
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

REPLIES: list[dict[str, Any]] = [
    {"content": "", "tool_calls": [("c1", "add", {"a": 2, "b": 3})]},
    {"content": ""},  # blank: asked again
    {"content": "It is 5."},
]


class ScriptedLLM(FunctionCallingLLM):
    """A function-calling LLM that replies from a script and records what it
    was sent."""

    replies: list[dict[str, Any]]
    sent: list[list[ChatMessage]] = Field(default_factory=list)
    tools: list[list[str]] = Field(default_factory=list)

    @property
    def metadata(self) -> LLMMetadata:
        return LLMMetadata(model_name="scripted", is_function_calling_model=True)

    def _prepare_chat_with_tools(
        self,
        tools: Sequence[Any],
        user_msg: Any = None,
        chat_history: list[ChatMessage] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        self.tools.append([t.metadata.name for t in tools])
        messages = list(chat_history or [])
        if isinstance(user_msg, str):
            messages.append(ChatMessage(role=MessageRole.USER, content=user_msg))
        elif user_msg is not None:
            messages.append(user_msg)
        return {"messages": messages}

    def get_tool_calls_from_response(
        self, response: ChatResponse, **kwargs: Any
    ) -> list[ToolSelection]:
        return [
            ToolSelection(tool_id=tool_id, tool_name=name, tool_kwargs=args)
            for tool_id, name, args in response.message.additional_kwargs.get(
                "tool_calls", []
            )
        ]

    async def achat(
        self, messages: Sequence[ChatMessage], **kwargs: Any
    ) -> ChatResponse:
        self.sent.append(list(messages))
        if not self.replies:
            raise AssertionError("the script ran out")
        reply = self.replies.pop(0)
        return ChatResponse(
            message=ChatMessage(
                role=MessageRole.ASSISTANT,
                content=reply["content"],
                additional_kwargs={"tool_calls": reply.get("tool_calls", [])},
            )
        )

    def chat(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def stream_chat(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def astream_chat(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def complete(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def acomplete(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def stream_complete(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def astream_complete(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError


def servers(tmp_path: Path) -> list[dict[str, Any]]:
    (tmp_path / "server.py").write_text(SERVER)
    return [
        {
            "name": "calc",
            "transport": "stdio",
            "command": sys.executable,
            "args": [str(tmp_path / "server.py")],
        }
    ]


def test_the_agent_works_the_task_with_the_servers_tools(tmp_path, monkeypatch):
    (tmp_path / "instruction.md").write_text("Add 2 and 3.")
    for name, value in {
        "CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "gpt-5.5"}),
        "CC_DRIVER_DIR": str(tmp_path),
        "CC_CONFIG": json.dumps({"max_bytes": 10}),
        "CC_INSTRUCTION_FILE": str(tmp_path / "instruction.md"),
        "CC_MCP_SERVERS_JSON": json.dumps(servers(tmp_path)),
        "CC_RESULT_FILE": str(tmp_path / "result.json"),
        "OPENAI_BASE_URL": "http://proxy/t/trial/openai/v1",
        "OPENAI_API_KEY": "cc-proxy",
        "CC_SYSTEM_PROMPT": "Work in /workspace.",
        "CC_HARNESS_TOOLS": "configure_run,record_termination",
    }.items():
        monkeypatch.setenv(name, value)
    scripted = ScriptedLLM(replies=list(REPLIES), sent=[], tools=[])
    monkeypatch.setattr(agent, "model", lambda target: scripted)
    assert asyncio.run(agent.main()) == 0

    first = scripted.sent[0]
    assert [m.role for m in first] == [MessageRole.SYSTEM, MessageRole.USER]
    assert first[0].content == "Work in /workspace."
    assert first[1].content == "Add 2 and 3."
    assert scripted.tools[0] == ["add"]
    last = scripted.sent[1][-1]
    assert last.role == MessageRole.TOOL
    assert last.additional_kwargs["tool_call_id"] == "c1"
    assert (
        last.content == "5 xxxxxxxx\n\n[truncated by base_llamaindex: 42 bytes removed]"
    )
    # Asked again after the blank reply, from the conversation without it.
    assert [m.role for m in scripted.sent[2]][-1] == MessageRole.TOOL
    result = json.loads((tmp_path / "result.json").read_text())
    assert result["stop_reason"] == "agent_done"
    assert (result["turns"], result["env_tool_calls"]) == (2, 1)
    assert result["messages"][-1]["blocks"][0]["text"] == "It is 5."


def test_the_step_cap_ends_the_run(tmp_path, monkeypatch):
    (tmp_path / "instruction.md").write_text("Add 2 and 3, forever.")
    for name, value in {
        "CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "gpt-5.5"}),
        "CC_CONFIG": "{}",
        "CC_MAX_STEPS": "2",
        "CC_INSTRUCTION_FILE": str(tmp_path / "instruction.md"),
        "CC_MCP_SERVERS_JSON": json.dumps(servers(tmp_path)),
        "CC_RESULT_FILE": str(tmp_path / "result.json"),
        "CC_HARNESS_TOOLS": "configure_run",
    }.items():
        monkeypatch.setenv(name, value)
    forever = [
        {"content": "", "tool_calls": [(f"c{n}", "add", {"a": n, "b": n})]}
        for n in range(1, 10)
    ]
    scripted = ScriptedLLM(replies=forever, sent=[], tools=[])
    monkeypatch.setattr(agent, "model", lambda target: scripted)
    assert asyncio.run(agent.main()) == 0

    result = json.loads((tmp_path / "result.json").read_text())
    assert result["stop_reason"] == "max_steps"
    # The cap stops the run at the second reply, before its tool call runs.
    assert (result["turns"], result["env_tool_calls"]) == (2, 1)
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
    (tmp_path / "instruction.md").write_text("Add 1 and 1, and 2 and 2.")
    for name, value in {
        "CC_TARGET_JSON": json.dumps({"provider": "openai", "model": "gpt-5.5"}),
        "CC_CONFIG": "{}",
        "CC_INSTRUCTION_FILE": str(tmp_path / "instruction.md"),
        "CC_MCP_SERVERS_JSON": json.dumps(servers(tmp_path)),
        "CC_RESULT_FILE": str(tmp_path / "result.json"),
    }.items():
        monkeypatch.setenv(name, value)
    replies = [
        {
            "content": "",
            "tool_calls": [
                ("c1", "add", {"a": 1, "b": 1}),
                ("c2", "add", {"a": 2, "b": 2}),
            ],
        },
        {"content": "Done."},
    ]
    scripted = ScriptedLLM(replies=replies, sent=[], tools=[])
    monkeypatch.setattr(agent, "model", lambda target: scripted)
    assert asyncio.run(agent.main()) == 0

    assert calls_ran_in_order(tmp_path)
    result = json.loads((tmp_path / "result.json").read_text())
    assert (result["turns"], result["env_tool_calls"]) == (2, 2)


def test_clip_leaves_small_results_alone():
    assert agent.clip("short", 10) == "short"
    assert agent.clip("x" * 12, 10) == "x" * 10 + agent.MARKER.format(dropped=2)
