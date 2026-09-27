"""base_agent's loop end to end: a real MCP server over stdio, the model
scripted."""

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

from litellm import ModelResponse

spec = importlib.util.spec_from_file_location(
    "base_agent", Path(__file__).parent / "agent.py"
)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

SERVER = """
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("calc")


@mcp.tool()
def configure_run(seed: int = 0) -> str:
    \"\"\"The harness's, not the model's.\"\"\"
    return "reset"


@mcp.tool()
def add(a: int, b: int) -> str:
    \"\"\"Add two numbers.\"\"\"
    return str(a + b) + " " + "x" * 50


mcp.run()
"""

REPLIES = [
    {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": "c1",
                "type": "function",
                "function": {"name": "add", "arguments": '{"a": 2, "b": 3}'},
            }
        ],
    },
    {"role": "assistant", "content": ""},  # blank: asked again
    {"role": "assistant", "content": "It is 5."},
]


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
    sent = []

    async def complete(**kwargs):
        sent.append(json.loads(json.dumps(kwargs)))
        return ModelResponse(choices=[{"message": REPLIES[len(sent) - 1]}])

    monkeypatch.setattr(agent, "complete", complete)
    assert asyncio.run(agent.main()) == 0

    first = sent[0]
    assert first["model"] == "openai/gpt-5.5"
    assert first["api_base"] == "http://proxy/t/trial/openai/v1"
    assert first["api_key"] == "cc-proxy"
    assert first["messages"] == [
        {"role": "system", "content": "Work in /workspace."},
        {"role": "user", "content": "Add 2 and 3."},
    ]
    assert [t["function"]["name"] for t in first["tools"]] == ["add"]
    assert sent[-1]["messages"][-1] == {
        "role": "tool",
        "tool_call_id": "c1",
        "content": "5 xxxxxxxx\n\n[truncated by base_agent: 42 bytes removed]",
    }
    result = json.loads((tmp_path / "result.json").read_text())
    assert result["stop_reason"] == "agent_done"
    assert (result["turns"], result["env_tool_calls"]) == (2, 1)
    assert result["messages"][-1]["content"] == "It is 5."
