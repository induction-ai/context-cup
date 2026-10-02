"""The environments' failure handling, with MCP sessions faked."""

from __future__ import annotations

import asyncio
import json
import types
from datetime import timedelta
from pathlib import Path
from typing import Any

import anyio
import pytest

from context_cup_protocol import ToolCallRef
from context_cup_runner.envs.tau3 import (
    Tau3Environment,
    assistant_tool_schemas,
    tau2_termination_reason,
)
from context_cup_runner.envs.toolathlon import (
    McpRouter,
    ToolathlonEnvironment,
    _connection_lost,
)


def text_result(payload: Any) -> types.SimpleNamespace:
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return types.SimpleNamespace(content=[types.SimpleNamespace(text=text)])


class FakeSession:
    """An MCP session answering call_tool from a table of name -> reply or
    exception, recording each call."""

    def __init__(self, replies: dict[str, Any]):
        self.replies = replies
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call_tool(
        self, name: str, arguments: dict[str, Any], read_timeout_seconds: Any = None
    ) -> Any:
        self.calls.append((name, arguments))
        reply = self.replies[name]
        if isinstance(reply, BaseException):
            raise reply
        return text_result(reply)


def tau3_env(session: FakeSession, tmp_path: Path) -> Tau3Environment:
    env = Tau3Environment(
        mcp_url="http://rt", instruction="<policy>p</policy>", seed=1, max_steps=5
    )
    env._session = session
    return env


def tool(name: str) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        name=name, description="", inputSchema={"type": "object"}
    )


# -- tau3 -------------------------------------------------------------------


def test_only_tau2_reasons_reach_record_termination():
    for reason in ("user_stop", "max_steps", "agent_error", "too_many_errors"):
        assert tau2_termination_reason(reason) == reason
    for reason in ("runner_error", "env_error", "final_message"):
        assert tau2_termination_reason(reason) == "agent_error"


def test_close_records_a_runner_failure_as_agent_error(tmp_path):
    session = FakeSession({"record_termination": {"termination_reason": "agent_error"}})
    env = tau3_env(session, tmp_path)
    asyncio.run(env.close("runner_error"))
    assert session.calls == [("record_termination", {"reason": "agent_error"})]


def test_the_listing_fallback_hides_the_runtime_s_controls(tmp_path):
    listed = [
        tool("get_balance"),
        tool("submit_assistant_message"),
        tool("configure_run"),
    ]
    assert [t["function"]["name"] for t in assistant_tool_schemas(listed)] == [
        "get_balance"
    ]
    session = FakeSession({"get_assistant_tool_schemas": RuntimeError("old runtime")})
    tools = asyncio.run(tau3_env(session, tmp_path)._assistant_tools(listed))
    assert [t["function"]["name"] for t in tools] == ["get_balance"]


def test_tool_schemas_must_be_a_list(tmp_path):
    session = FakeSession({"get_assistant_tool_schemas": {"not": "a list"}})
    with pytest.raises(TypeError, match="JSON list"):
        asyncio.run(tau3_env(session, tmp_path)._assistant_tools([]))
    schemas = [{"type": "function", "function": {"name": "x"}}]
    session = FakeSession({"get_assistant_tool_schemas": schemas})
    assert asyncio.run(tau3_env(session, tmp_path)._assistant_tools([])) == schemas


def test_no_tool_schemas_falls_back_to_the_listing(tmp_path):
    listed = [tool("get_balance")]
    session = FakeSession({"get_assistant_tool_schemas": []})
    tools = asyncio.run(tau3_env(session, tmp_path)._assistant_tools(listed))
    assert [t["function"]["name"] for t in tools] == ["get_balance"]


# -- toolathlon: the MCP link ----------------------------------------------


def test_a_closed_mcp_connection_counts_as_lost():
    from mcp import McpError
    from mcp.types import CONNECTION_CLOSED, INTERNAL_ERROR, ErrorData

    closed = McpError(ErrorData(code=CONNECTION_CLOSED, message="closed"))
    assert _connection_lost(closed)
    assert _connection_lost(ExceptionGroup("g", [closed]))
    assert _connection_lost(anyio.ClosedResourceError())
    assert not _connection_lost(McpError(ErrorData(code=INTERNAL_ERROR, message="x")))
    assert not _connection_lost(ValueError("bad args"))


def router(max_unanswered: int = 3) -> McpRouter:
    return McpRouter([], timeout=timedelta(seconds=1), max_unanswered=max_unanswered)


def test_a_half_rebuild_is_torn_down(monkeypatch):
    r = router()
    closes: list[str] = []

    async def half_connect() -> None:
        r._owner["orphan"] = (object(), "orphan")
        raise ConnectionError("gateway down")

    async def close() -> None:
        closes.append("close")

    monkeypatch.setattr(r, "connect", half_connect)
    monkeypatch.setattr(r, "close", close)
    with pytest.raises(ConnectionError):
        asyncio.run(r.reconnect())
    assert r._owner == {} and r.tools == []
    assert closes == ["close", "close"]


def test_calls_after_a_failed_rebuild_retry_the_link_and_count(monkeypatch):
    r = router(max_unanswered=2)

    async def reconnect() -> None:
        raise ConnectionError("gateway down")

    monkeypatch.setattr(r, "reconnect", reconnect)
    first = asyncio.run(r.call("anything", {}))
    assert first == "MCP tool error:\nConnectionError: gateway down"
    with pytest.raises(RuntimeError, match="unusable after 2 unanswered calls"):
        asyncio.run(r.call("anything", {}))


def test_a_rebuild_that_exposes_no_tools_is_unanswered(monkeypatch):
    r = router()

    async def reconnect() -> None:
        return None

    monkeypatch.setattr(r, "reconnect", reconnect)
    assert asyncio.run(r.call("x", {})) == (
        "MCP tool error:\nRuntimeError: MCP rebuild exposed no tools"
    )
    assert r.unanswered == 1


def test_a_connection_lost_mid_call_is_rebuilt_and_reported(monkeypatch):
    r = router()
    r._owner["search"] = (FakeSession({"search": anyio.EndOfStream()}), "search")
    rebuilt: list[bool] = []

    async def reconnect() -> None:
        rebuilt.append(True)

    monkeypatch.setattr(r, "reconnect", reconnect)
    output = asyncio.run(r.call("search", {"q": 1}))
    assert rebuilt == [True] and r.unanswered == 1
    assert "dropped during search and was rebuilt" in output


def test_an_agent_is_kept_off_the_harness_s_tau3_controls():
    from context_cup_runner.envs.tau3 import HARNESS_TOOL_NAMES

    assert "configure_run" in HARNESS_TOOL_NAMES
    assert "submit_assistant_message" in HARNESS_TOOL_NAMES
    assert not {"start_conversation", "send_message_to_user"} & HARNESS_TOOL_NAMES


def test_an_agent_s_tau3_run_is_seeded_but_not_started(tmp_path, monkeypatch):
    session = FakeSession({"configure_run": {"step_count": 0}})
    env = tau3_env(session, tmp_path)

    async def connect() -> None:
        env._session = session

    monkeypatch.setattr(env, "_connect", connect)
    asyncio.run(env.configure_for_agent())
    assert session.calls == [
        ("configure_run", {"seed": 1, "max_steps": 5, "max_errors": 10})
    ]


def test_tau3_passes_a_long_tool_result_whole(tmp_path):
    long = "x" * 200_000
    session = FakeSession(
        {
            "submit_assistant_tool_calls": {
                "tool_results": [{"id": "c1", "content": long}]
            }
        }
    )
    env = tau3_env(session, tmp_path)
    step = asyncio.run(env.on_tool_calls([ToolCallRef("c1", "a", {})], None))
    assert [r.content for r in step.tool_results] == [long]


def test_toolathlon_passes_a_long_tool_result_whole():
    env = ToolathlonEnvironment(
        servers=[], instruction="task", bundle={}, workspace_dir="/w"
    )
    long_text = "a" * 200_000

    async def mcp_call(name: str, arguments: dict[str, Any]) -> str:
        return long_text

    env.router.call = mcp_call  # type: ignore[method-assign]
    step = asyncio.run(env.on_tool_calls([ToolCallRef("c1", "fetch", {})], None))
    assert step.tool_results[0].content == long_text
    assert ToolathlonEnvironment.fail_at_max_steps is True
    assert Tau3Environment.fail_at_max_steps is False
