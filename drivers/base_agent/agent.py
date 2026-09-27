"""base_agent: a whole agent written from scratch, in one file.

No framework and no turn protocol: this process gets harbor's instruction and
the task's MCP servers, and runs the loop itself. It sends the conversation to
the model, runs the tools the model asks for on the MCP servers, appends the
results, and repeats until the model answers without calling a tool. It owns
the whole conversation, so the context strategy lives here too. This one
clips any tool result over `max_bytes`, like base_python, so the two are
comparable.

The conversation is a plain list of chat messages, and LiteLLM carries it to
OpenAI, Anthropic, or Gemini, so one loop serves all three. Every call goes
through the trial's proxy (the base URLs and the placeholder key are in the
environment), which records it. docs/protocol.md, "Agent drivers", has
everything agent.sh is handed.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Collection
from contextlib import AsyncExitStack
from datetime import timedelta
from pathlib import Path
from typing import Any

# Before litellm is imported: its bundled price map, not one fetched over
# the network (a trial container has no business reaching for it).
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

import litellm
from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamablehttp_client

SYSTEM = (
    "You are an autonomous agent. Work the task below with the tools you are "
    "given, calling as many as you need. When the task is complete, reply with "
    "a short final answer and no tool calls."
)
MARKER = "\n\n[truncated by base_agent: {dropped} bytes removed]"
EMPTY_RETRIES = 3
TOOL_TIMEOUT = timedelta(seconds=270)


def clip(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text
    kept = raw[:max_bytes].decode("utf-8", errors="ignore")
    return kept + MARKER.format(dropped=len(raw) - max_bytes)


class Tools:
    """Sessions to the task's MCP servers, with each tool routed back to the
    server that offers it."""

    def __init__(self) -> None:
        self.schemas: list[dict[str, Any]] = []
        self._owner: dict[str, tuple[ClientSession, str]] = {}

    async def connect(
        self,
        stack: AsyncExitStack,
        servers: list[dict[str, Any]],
        hidden: Collection[str] = (),
    ) -> None:
        for server in servers:
            transport = server.get("transport")
            if transport == "streamable-http":
                read, write, _ = await stack.enter_async_context(
                    streamablehttp_client(server["url"])
                )
            elif transport == "sse":
                read, write = await stack.enter_async_context(sse_client(server["url"]))
            elif transport == "stdio":
                params = StdioServerParameters(
                    command=server["command"], args=server.get("args") or []
                )
                read, write = await stack.enter_async_context(stdio_client(params))
            else:
                raise ValueError(f"unsupported MCP transport {transport!r}")
            session = await stack.enter_async_context(
                ClientSession(read, write, read_timeout_seconds=TOOL_TIMEOUT)
            )
            await session.initialize()
            for tool in (await session.list_tools()).tools:
                if tool.name in hidden:
                    continue  # the harness's, not the model's
                # A name two servers share goes to the first; the second is
                # offered under its server's name.
                name = (
                    tool.name
                    if tool.name not in self._owner
                    else f"{server['name']}__{tool.name}"
                )
                self._owner[name] = (session, tool.name)
                self.schemas.append(
                    {
                        "type": "function",
                        "function": {
                            "name": name,
                            "description": tool.description or "",
                            "parameters": tool.inputSchema
                            or {"type": "object", "properties": {}},
                        },
                    }
                )

    async def call(self, name: str, arguments: str) -> str:
        """The tool's result as text. A failure is text too: the model reads
        it and decides what to do."""
        if name not in self._owner:
            return f"Error: there is no tool named {name}"
        try:
            parsed = json.loads(arguments or "{}")
        except json.JSONDecodeError as exc:
            return f"Error: the arguments are not JSON: {exc}"
        session, tool = self._owner[name]
        try:
            result = await session.call_tool(tool, parsed)
        except Exception as exc:  # noqa: BLE001 - the model gets the message
            return f"Error calling {name}: {type(exc).__name__}: {exc}"
        parts = [
            item.text
            if hasattr(item, "text")
            else json.dumps(item.model_dump(mode="json"))
            for item in result.content
        ]
        if not parts and result.structuredContent is not None:
            parts.append(json.dumps(result.structuredContent))
        text = "\n".join(parts)
        return f"Error: {text}" if result.isError else text


def connection(provider: str) -> dict[str, str]:
    """Where LiteLLM sends a call for the run's provider: the trial's proxy,
    with the placeholder key."""
    env = os.environ
    if provider == "openai":
        return {"api_base": env["OPENAI_BASE_URL"], "api_key": env["OPENAI_API_KEY"]}
    if provider == "anthropic":
        return {
            "api_base": env["ANTHROPIC_BASE_URL"],
            "api_key": env["ANTHROPIC_API_KEY"],
        }
    return {
        "api_base": f"{env['GOOGLE_GEMINI_BASE_URL']}/v1beta",
        "api_key": env["GEMINI_API_KEY"],
    }


async def complete(**kwargs: Any) -> Any:
    """One model call. Kept apart so a test can stand in for the model."""
    return await litellm.acompletion(**kwargs)


async def main() -> int:
    env = os.environ
    target = json.loads(env["CC_TARGET_JSON"])
    provider = target["provider"]
    # The runner hands over the manifest's `config` (pyproject.toml's
    # [tool.context-cup.config]) as JSON.
    config = json.loads(env.get("CC_CONFIG") or "{}")
    max_bytes = int(config.get("max_bytes", 100_000))
    max_steps = int(env.get("CC_MAX_STEPS") or 150)
    instruction = Path(env["CC_INSTRUCTION_FILE"]).read_text(encoding="utf-8")  # noqa: ASYNC240 - before any concurrent work
    effort = target.get("reasoning_effort")

    # The conversation: this list is what the model sees, and a context
    # strategy is whatever this agent does to it before each call.
    messages: list[dict[str, Any]] = [
        # The benchmark's own system prompt when it has one outside the
        # instruction (Toolathlon's: the workspace, how to finish).
        {"role": "system", "content": env.get("CC_SYSTEM_PROMPT") or SYSTEM},
        {"role": "user", "content": instruction},
    ]
    result: dict[str, Any] = {
        "stop_reason": "max_steps",
        "turns": 0,
        "env_tool_calls": 0,
    }
    tools = Tools()
    try:
        async with AsyncExitStack() as stack:
            # Tools the course reserves for the harness (tau3's runtime
            # controls) are listed by the server but never offered.
            hidden = set(filter(None, env.get("CC_HARNESS_TOOLS", "").split(",")))
            await tools.connect(stack, json.loads(env["CC_MCP_SERVERS_JSON"]), hidden)
            print(f"[agent] {len(tools.schemas)} tools", flush=True)
            empty = 0
            while result["turns"] < max_steps:
                response = await complete(
                    model=f"{provider}/{target['model']}",
                    messages=messages,
                    tools=tools.schemas or None,
                    **connection(provider),
                    **(
                        {"reasoning_effort": effort}
                        if effort and effort != "none"
                        else {}
                    ),
                    drop_params=True,
                    timeout=600,
                )
                message = response.choices[0].message
                calls = message.tool_calls or []
                if not calls and not (message.content or "").strip():
                    # A blank reply is a provider hiccup: ask again.
                    empty += 1
                    if empty > EMPTY_RETRIES:
                        result["stop_reason"] = "empty_replies"
                        break
                    continue
                result["turns"] += 1
                # LiteLLM's own message, dumped: it carries what the next call
                # needs back (Gemini's thought signatures, Anthropic's
                # thinking blocks) as well as the text and the tool calls.
                messages.append(message.model_dump(exclude_none=True))
                if not calls:
                    result["stop_reason"] = "agent_done"
                    print(f"[agent] done: {(message.content or '')[:500]}", flush=True)
                    break
                for call in calls:
                    output = await tools.call(
                        call.function.name, call.function.arguments
                    )
                    print(
                        f"[agent] {call.function.name} -> {len(output)} chars",
                        flush=True,
                    )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.id,
                            "content": clip(output, max_bytes),
                        }
                    )
                    result["env_tool_calls"] += 1
    finally:
        # The runner reads the counts into the trial's summary; the messages
        # are kept for whoever reads the trial afterwards.
        result["messages"] = messages
        Path(env["CC_RESULT_FILE"]).write_text(json.dumps(result, default=str))  # noqa: ASYNC240 - after all concurrent work
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
