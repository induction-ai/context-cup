"""Toolathlon environment: one MCP gateway (SSE) exposes the task's tools.
The assistant works until it calls a stop tool (claim_done) or replies with
plain text.

Settings:
  CC_MCP_SERVERS_JSON      harbor's MCP server list; default is the gateway
  CC_INSTRUCTION_FILE      the task text, sent as the first user message
  CC_TOOLATHLON_BUNDLE     task bundle path, default /workspace/dumps/task_bundle.json
  CC_WORKSPACE_DIR         default /workspace/dumps/workspace
  CC_TOOL_TIMEOUT_SEC      per MCP call, default 270
  CC_MAX_UNANSWERED_CALLS  dead-link threshold, default 3
  CC_MAX_TOOL_OUTPUT_CHARS longer results are cut, default 100000
  CC_TRUNCATE_TOOL_OUTPUT  on (default), off, or no_json (cut all but JSON)

A cut result is saved under a short id; the four overlong-output tools
(overlong.py) let the model search and page through it, and their own
results are never cut.
"""

from __future__ import annotations

import json
from contextlib import AsyncExitStack
from datetime import timedelta
from pathlib import Path
from typing import Any

import anyio
from context_cup_protocol import ToolCallRef, Utterance

from ..environment import EnvironmentStart, StepResult, ToolResult
from ..mcp_util import mcp_tool_to_function_tool, result_text
from ..overlong import OVERLONG_DIR_NAME, OVERLONG_TOOLS, OverlongOutputs, TruncateMode

DEFAULT_GATEWAY = {"name": "gw", "transport": "sse", "url": "http://127.0.0.1:8765/sse"}
DEFAULT_STOP_TOOLS = ["local-claim_done"]
DEFAULT_BUNDLE = "/workspace/dumps/task_bundle.json"
DEFAULT_WORKSPACE = "/workspace/dumps/workspace"
DEFAULT_MAX_TOOL_OUTPUT_CHARS = 100_000
TRUNCATE_MODES: tuple[TruncateMode, ...] = ("on", "off", "no_json")


def read_bundle(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def bundle_system_prompt(bundle: dict[str, Any]) -> str | None:
    prompt = (bundle.get("system_prompts") or {}).get("agent")
    return prompt if isinstance(prompt, str) and prompt.strip() else None


def bundle_stop_tools(bundle: dict[str, Any]) -> list[str]:
    names = (bundle.get("stop") or {}).get("tool_names")
    if isinstance(names, list) and names:
        return [n for n in names if isinstance(n, str) and n]
    return list(DEFAULT_STOP_TOOLS)


def _connection_lost(exc: BaseException) -> bool:
    """Whether the transport is gone and only a rebuild brings it back."""
    nested = getattr(exc, "exceptions", None)
    if nested:
        return any(_connection_lost(inner) for inner in nested)
    if isinstance(
        exc, (anyio.ClosedResourceError, anyio.BrokenResourceError, anyio.EndOfStream)
    ):
        return True
    from mcp import McpError
    from mcp.types import CONNECTION_CLOSED

    return isinstance(exc, McpError) and exc.error.code == CONNECTION_CLOSED


class McpRouter:
    """Sessions to every configured server, with tool names routed back to
    the session that owns them and a rebuild when a transport dies."""

    def __init__(
        self, servers: list[dict[str, Any]], *, timeout: timedelta, max_unanswered: int
    ):
        self.servers = servers
        self.timeout = timeout
        self.max_unanswered = max_unanswered
        self.unanswered = 0
        self._stack = AsyncExitStack()
        self._owner: dict[str, tuple[Any, str]] = {}
        self.tools: list[dict[str, Any]] = []

    async def connect(self) -> None:
        from mcp import ClientSession
        from mcp.client.sse import sse_client
        from mcp.client.stdio import StdioServerParameters, stdio_client

        for server in self.servers:
            transport = server.get("transport", "sse")
            if transport == "sse":
                read, write = await self._stack.enter_async_context(
                    sse_client(server["url"])
                )
            elif transport == "stdio":
                params = StdioServerParameters(
                    command=server["command"], args=server.get("args") or []
                )
                read, write = await self._stack.enter_async_context(
                    stdio_client(params)
                )
            else:
                raise ValueError(f"unsupported MCP transport {transport!r}")
            session = await self._stack.enter_async_context(
                ClientSession(read, write, read_timeout_seconds=self.timeout)
            )
            await session.initialize()
            listed = await session.list_tools()
            for tool in listed.tools:
                routed = (
                    tool.name
                    if tool.name not in self._owner
                    else f"{server['name']}__{tool.name}"
                )
                self._owner[routed] = (session, tool.name)
                self.tools.append(mcp_tool_to_function_tool(tool, name=routed))

    async def _reset(self) -> None:
        await self.close()
        self._stack = AsyncExitStack()
        self._owner.clear()
        self.tools.clear()

    async def reconnect(self) -> None:
        """Rebuild every session: a failed transport stays closed for good."""
        await self._reset()
        try:
            await self.connect()
        except Exception:
            # Half a rebuild leaves sessions open that nothing routes to.
            await self._reset()
            raise

    async def close(self) -> None:
        try:
            await self._stack.aclose()
        except BaseException as exc:  # noqa: BLE001 - anyio groups leak through here
            print(f"[runner] MCP teardown: {type(exc).__name__}: {exc}", flush=True)

    def _count_unanswered(self, exc: BaseException) -> None:
        self.unanswered += 1
        if self.unanswered >= self.max_unanswered:
            raise RuntimeError(
                f"MCP unusable after {self.unanswered} unanswered calls"
            ) from exc

    def _unanswered(self, exc: BaseException) -> str:
        self._count_unanswered(exc)
        return f"MCP tool error:\n{type(exc).__name__}: {exc}"

    async def call(self, name: str, arguments: dict[str, Any]) -> str:
        if not self._owner:
            # An earlier rebuild failed, so this call has not reached any
            # server yet; running it once the link is back repeats nothing.
            try:
                await self.reconnect()
            except Exception as exc:  # noqa: BLE001
                return self._unanswered(exc)
            if not self._owner:
                return self._unanswered(RuntimeError("MCP rebuild exposed no tools"))
        if name not in self._owner:
            return f"MCP tool error:\nunknown tool {name!r}"
        session, actual = self._owner[name]
        try:
            result = await session.call_tool(
                actual, arguments, read_timeout_seconds=self.timeout
            )
        except Exception as exc:  # noqa: BLE001 - surface to the model, not the run
            if _connection_lost(exc):
                self._count_unanswered(exc)
                try:
                    await self.reconnect()
                except Exception as rebuild:  # noqa: BLE001
                    return f"MCP tool error:\n{type(rebuild).__name__}: {rebuild}"
                return (
                    f"MCP tool error:\nThe connection dropped during {name} and was rebuilt. "
                    "The server may or may not have run that call; check state before retrying."
                )
            return f"MCP tool error:\n{type(exc).__name__}: {exc}"
        self.unanswered = 0
        text = result_text(result)
        if getattr(result, "isError", False):
            return "MCP tool error:\n" + text
        return text


class ToolathlonEnvironment:
    name = "toolathlon"
    fail_at_max_steps = True
    """Toolathlon has no cap of its own; running out of steps is a failed
    trial, as in upstream Toolathlon."""

    def __init__(
        self,
        *,
        servers: list[dict[str, Any]],
        instruction: str,
        bundle: dict[str, Any],
        workspace_dir: str,
        agent_dir: Path,
        tool_timeout_sec: float = 270.0,
        max_unanswered: int = 3,
        max_tool_output_chars: int = DEFAULT_MAX_TOOL_OUTPUT_CHARS,
        truncate: TruncateMode = "on",
    ):
        self.instruction = instruction
        self.overlong = OverlongOutputs(
            agent_dir / OVERLONG_DIR_NAME,
            max_chars=max_tool_output_chars,
            mode=truncate,
        )
        self.system_prompt = bundle_system_prompt(bundle)
        self.stop_tools = set(bundle_stop_tools(bundle))
        self.workspace_dir = workspace_dir
        self.router = McpRouter(
            servers,
            timeout=timedelta(seconds=tool_timeout_sec),
            max_unanswered=max_unanswered,
        )

    @classmethod
    def from_env(cls, env: dict[str, str], *, agent_dir: Path) -> ToolathlonEnvironment:
        raw = env.get("CC_MCP_SERVERS_JSON")
        servers = json.loads(raw) if raw else []
        bundle_path = Path(env.get("CC_TOOLATHLON_BUNDLE") or DEFAULT_BUNDLE)
        truncate = env.get("CC_TRUNCATE_TOOL_OUTPUT") or "on"
        if truncate not in TRUNCATE_MODES:
            raise ValueError(
                f"CC_TRUNCATE_TOOL_OUTPUT must be one of {', '.join(TRUNCATE_MODES)}"
            )
        return cls(
            servers=servers or [dict(DEFAULT_GATEWAY)],
            instruction=Path(env["CC_INSTRUCTION_FILE"]).read_text(encoding="utf-8"),
            bundle=read_bundle(bundle_path),
            workspace_dir=env.get("CC_WORKSPACE_DIR") or DEFAULT_WORKSPACE,
            agent_dir=agent_dir,
            tool_timeout_sec=float(env.get("CC_TOOL_TIMEOUT_SEC") or 270.0),
            max_unanswered=int(env.get("CC_MAX_UNANSWERED_CALLS") or 3),
            max_tool_output_chars=int(
                env.get("CC_MAX_TOOL_OUTPUT_CHARS") or DEFAULT_MAX_TOOL_OUTPUT_CHARS
            ),
            truncate=truncate,
        )

    async def open(self) -> EnvironmentStart:
        await self.router.connect()
        print(
            f"[runner] MCP tools: {', '.join(t['function']['name'] for t in self.router.tools)}",
            flush=True,
        )
        return EnvironmentStart(
            system=self.system_prompt,
            opening=[Utterance("user", self.instruction)],
            tools=[*self.router.tools, *OVERLONG_TOOLS],
            workspace_dir=self.workspace_dir,
        )

    async def on_tool_calls(
        self, tool_calls: list[ToolCallRef], text: str | None
    ) -> StepResult:
        results = []
        stop: str | None = None
        for call in tool_calls:
            if "_raw" in call.arguments:
                results.append(
                    ToolResult(call.id, "Invalid tool arguments: not a JSON object")
                )
                continue
            if self.overlong.handles(call.name):
                # Read-back of a saved output: never cut again.
                output = self.overlong.call(call.name, call.arguments)
            else:
                output = self.overlong.clip(
                    await self.router.call(call.name, call.arguments)
                )
            print(f"[runner] tool {call.name}: {output[:400]!r}", flush=True)
            results.append(ToolResult(call.id, output))
            if call.name in self.stop_tools:
                stop = "stop_tool"
        return StepResult(tool_results=results, stop_reason=stop)

    async def on_message(self, text: str) -> StepResult:
        return StepResult(stop_reason="final_message")

    async def close(self, stop_reason: str) -> dict[str, Any]:
        await self.router.close()
        return {}
