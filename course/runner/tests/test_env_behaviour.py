"""The environments' failure handling and the Toolathlon overlong-output
tools, with MCP sessions faked."""

from __future__ import annotations

import asyncio
import json
import re
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
from context_cup_runner.overlong import OVERLONG_TOOLS, OverlongOutputs


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


def test_tau3_cuts_a_tool_result_over_the_cap(tmp_path):
    long = "x" * 50
    session = FakeSession(
        {
            "submit_assistant_tool_calls": {
                "tool_results": [
                    {"id": "c/1", "content": long},
                    {"id": "c2", "content": "short"},
                ]
            }
        }
    )
    env = tau3_env(session, tmp_path)
    env.agent_dir = tmp_path
    env.max_tool_output_chars = 20
    step = asyncio.run(
        env.on_tool_calls(
            [ToolCallRef("c/1", "a", {}), ToolCallRef("c2", "b", {})], None
        )
    )
    saved = tmp_path / "clipped_tool_outputs" / "c_1.txt"
    assert [r.content for r in step.tool_results] == [
        "x" * 20 + "\n\n[Tool output clipped: showing the first 20 of 50 "
        f"characters. The full output was saved to {saved}.]",
        "short",
    ]
    assert saved.read_text() == long


# -- toolathlon: overlong outputs -------------------------------------------


def test_a_long_output_is_cut_with_its_shortuuid(tmp_path):
    store = OverlongOutputs(tmp_path / "saved", max_chars=100)
    assert store.clip("short") == "short"
    text = "line\n" * 100
    clipped = store.clip(text)
    assert clipped.startswith(text[:100] + " ...\n\n(The output of the tool call")
    found = re.search(r"shortuuid identifier: ([0-9a-f]{32})", clipped)
    assert found is not None
    assert "original output length is 500 characters" in clipped
    saved = tmp_path / "saved" / f"{found.group(1)}.json"
    assert saved.read_text() == text
    assert str(saved) in clipped


def test_truncation_modes(tmp_path):
    long_json = json.dumps({"rows": ["x" * 50] * 10})
    assert (
        OverlongOutputs(tmp_path, max_chars=10, mode="off").clip("y" * 50) == "y" * 50
    )
    no_json = OverlongOutputs(tmp_path, max_chars=10, mode="no_json")
    assert no_json.clip(long_json) == long_json
    assert no_json.clip("z" * 50).startswith("z" * 10 + " ...")


def test_the_overlong_tools_search_and_page_the_saved_text(tmp_path):
    store = OverlongOutputs(tmp_path, max_chars=10)
    text = "".join(f"row {i} value={i * 7}\n" for i in range(40))
    shortuuid = re.search(r"identifier: (\w+)", store.clip(text)).group(1)  # type: ignore[union-attr]

    found = store.call(
        "local-search_overlong_tooloutput",
        {"shortuuid": shortuuid, "pattern": r"value=\d+4\b", "page_size": 2},
    )
    assert "Total matches: 4" in found and "(Page 1/2)" in found
    assert ">>>value=14<<<" in found
    session_id = re.search(r"Search Session ID: (\w+)", found).group(1)  # type: ignore[union-attr]
    page_two = store.call(
        "local-search_overlong_tooloutput_navigate",
        {"search_session_id": session_id, "action": "next_page"},
    )
    assert "(Page 2/2)" in page_two and "Match 3" in page_two

    viewed = store.call(
        "local-view_overlong_tooloutput", {"shortuuid": shortuuid, "page_size": 100}
    )
    assert "Characters 0-100 of" in viewed and text[:100] in viewed
    view_id = re.search(r"View Session ID: (\w+)", viewed).group(1)  # type: ignore[union-attr]
    last = store.call(
        "local-view_overlong_tooloutput_navigate",
        {"view_session_id": view_id, "action": "last_page"},
    )
    assert "[End of file reached" in last and text[-40:] in last

    assert store.call("local-view_overlong_tooloutput", {"shortuuid": "nope"}) == (
        "Error: No overlong tool output found for shortuuid: nope"
    )
    assert store.call(
        "local-search_overlong_tooloutput", {"shortuuid": shortuuid, "pattern": "("}
    ).startswith("Error: Invalid regex pattern")
    assert "Local tool error" in store.call(
        "local-view_overlong_tooloutput", {"shortuuid": shortuuid, "page_size": [1]}
    )


def test_a_shortuuid_cannot_reach_outside_the_saved_outputs(tmp_path):
    store = OverlongOutputs(tmp_path / "saved", max_chars=10)
    (tmp_path / "secret.json").write_text("do not show")
    for name in ("local-view_overlong_tooloutput", "local-search_overlong_tooloutput"):
        out = store.call(name, {"shortuuid": "../secret", "pattern": "show"})
        assert out == "Error: No overlong tool output found for shortuuid: ../secret"


def test_a_search_keeps_its_matches_bounded(tmp_path, monkeypatch):
    store = OverlongOutputs(tmp_path, max_chars=10)
    shortuuid = re.search(r"identifier: (\w+)", store.clip("ab" * 5_000)).group(1)  # type: ignore[union-attr]
    empty = store.call(
        "local-search_overlong_tooloutput", {"shortuuid": shortuuid, "pattern": "x?"}
    )
    assert empty.startswith("No matches found"), "empty matches are not kept"
    many = store.call(
        "local-search_overlong_tooloutput", {"shortuuid": shortuuid, "pattern": "b"}
    )
    assert "Total matches: 1000+ (only the first 1000 are kept)" in many

    monkeypatch.setattr("context_cup_runner.overlong.SEARCH_TIMEOUT_SEC", 0.2)
    shortuuid = re.search(  # type: ignore[union-attr]
        r"identifier: (\w+)", store.clip("a" * 40 + "b")
    ).group(1)
    slow = store.call(
        "local-search_overlong_tooloutput",
        {"shortuuid": shortuuid, "pattern": "(a+)+$"},
    )
    assert slow == (
        "Error: the search for '(a+)+$' took longer than 0.2 seconds; "
        "use a simpler pattern"
    )


def test_toolathlon_offers_the_tools_and_never_cuts_their_output(tmp_path):
    env = ToolathlonEnvironment(
        servers=[],
        instruction="task",
        bundle={},
        workspace_dir="/w",
        agent_dir=tmp_path,
        max_tool_output_chars=50,
    )
    long_text = "a" * 60 + "\n" + "b" * 200

    async def mcp_call(name: str, arguments: dict[str, Any]) -> str:
        return long_text

    env.router.call = mcp_call  # type: ignore[method-assign]
    step = asyncio.run(env.on_tool_calls([ToolCallRef("c1", "fetch", {})], None))
    clipped = step.tool_results[0].content
    assert clipped.startswith("a" * 50 + " ...")
    shortuuid = re.search(r"identifier: (\w+)", clipped).group(1)  # type: ignore[union-attr]
    step = asyncio.run(
        env.on_tool_calls(
            [
                ToolCallRef(
                    "c2",
                    "local-view_overlong_tooloutput",
                    {"shortuuid": shortuuid, "page_size": 1000},
                )
            ],
            None,
        )
    )
    assert "b" * 200 in step.tool_results[0].content
    names = {t["function"]["name"] for t in OVERLONG_TOOLS}
    assert names == {
        "local-search_overlong_tooloutput",
        "local-search_overlong_tooloutput_navigate",
        "local-view_overlong_tooloutput",
        "local-view_overlong_tooloutput_navigate",
    }
    assert ToolathlonEnvironment.fail_at_max_steps is True
    assert Tau3Environment.fail_at_max_steps is False


def test_toolathlon_rejects_an_unknown_truncate_mode(tmp_path):
    instruction = tmp_path / "i.txt"
    instruction.write_text("task")
    with pytest.raises(ValueError, match="CC_TRUNCATE_TOOL_OUTPUT"):
        ToolathlonEnvironment.from_env(
            {
                "CC_INSTRUCTION_FILE": str(instruction),
                "CC_TRUNCATE_TOOL_OUTPUT": "maybe",
            },
            agent_dir=tmp_path,
        )
