"""base_langchain: a whole agent on LangChain, in one file.

LangChain's `create_agent` runs the loop: it sends the conversation to the
model, runs the tools the model asks for, appends the results, and repeats
until the model answers without calling a tool. The tools are the task's MCP
servers, loaded through langchain-mcp-adapters, and every model call goes
through the trial's proxy (the base URLs and the placeholder key are in the
environment), which records it. The context strategy is middleware: this one
clips any tool result over `max_bytes`, like base_python and base_agent, so
the three are comparable.

Each provider's own chat model carries what its next call needs back
(Anthropic's thinking blocks, Gemini's thought signatures, OpenAI's reasoning
items), so one agent serves all three. docs/protocol.md, "Agent drivers", has
everything agent.sh is handed.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Awaitable, Callable, Collection
from contextlib import AsyncExitStack
from datetime import timedelta
from pathlib import Path
from typing import Any, NotRequired, TypedDict

from langchain.agents import create_agent
from langchain.agents.middleware import (
    AgentMiddleware,
    ModelCallLimitMiddleware,
    ModelRequest,
    ModelResponse,
    ToolCallRequest,
    wrap_model_call,
    wrap_tool_call,
)
from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    ToolMessage,
    messages_to_dict,
)
from langchain_core.tools import BaseTool, StructuredTool
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import Connection
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_openai import ChatOpenAI
from langgraph.types import Command

SYSTEM = (
    "You are an autonomous agent. Work the task below with the tools you are "
    "given, calling as many as you need. When the task is complete, reply with "
    "a short final answer and no tool calls."
)
MARKER = "\n\n[truncated by base_langchain: {dropped} bytes removed]"
EMPTY_RETRIES = 3
TOOL_TIMEOUT = timedelta(seconds=270)
MODEL_TIMEOUT = 600
# The course's own settings per provider (course/protocol), so the agent
# faces the model the turn loop would: reasoning effort as a thinking budget
# where the provider takes one, and Anthropic's output cap.
THINKING_BUDGETS = {
    "anthropic": {"low": 2_048, "medium": 8_192, "high": 32_768},
    "gemini": {"low": 1_024, "medium": 8_192, "high": 24_576},
}
ANTHROPIC_MAX_TOKENS = 16_384
# LangGraph counts every node (middleware hooks included) toward its
# recursion limit; a generous multiple keeps it out of the way of the model
# call limit, which is the cap that counts.
NODES_PER_STEP = 8


class Target(TypedDict):
    """The run's target, from CC_TARGET_JSON."""

    provider: str
    model: str
    reasoning_effort: NotRequired[str | None]


class Server(TypedDict):
    """A task MCP server, from CC_MCP_SERVERS_JSON: `url` for streamable-http
    and sse, `command` and `args` for stdio."""

    name: str
    transport: str
    url: NotRequired[str]
    command: NotRequired[str]
    args: NotRequired[list[str]]


def clip(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text
    kept = raw[:max_bytes].decode("utf-8", errors="ignore")
    return kept + MARKER.format(dropped=len(raw) - max_bytes)


def tool_text(message: ToolMessage) -> str:
    """A tool result as one string: the adapter hands text blocks back as a
    list, and anything else (an image, a resource) as a block to describe."""
    content = message.content
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text", "")))
        else:
            parts.append(json.dumps(block, default=str))
    return "\n".join(parts)


ToolHandler = Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]]
ModelHandler = Callable[[ModelRequest], Awaitable[ModelResponse]]


def one_at_a_time(lock: asyncio.Lock) -> AgentMiddleware:
    """A turn's tool calls run in order, as the course's own loop runs
    them: tau3's runtime logs each call for its verifier, and calls made
    concurrently interleave the log, which fails the trial's scoring."""

    @wrap_tool_call
    async def in_turn(
        request: ToolCallRequest, handler: ToolHandler
    ) -> ToolMessage | Command[Any]:
        async with lock:
            return await handler(request)

    return in_turn


def clip_tool_results(max_bytes: int) -> AgentMiddleware:
    """The context strategy, as middleware around every tool call: the
    result reaches the model as text, clipped to `max_bytes`."""

    @wrap_tool_call
    async def clip_tool_result(
        request: ToolCallRequest, handler: ToolHandler
    ) -> ToolMessage | Command[Any]:
        result = await handler(request)
        if isinstance(result, ToolMessage):
            text = tool_text(result)
            print(
                f"[agent] {request.tool_call['name']} -> {len(text)} chars", flush=True
            )
            result.content = clip(text, max_bytes)
        return result

    return clip_tool_result


def blank(messages: list[BaseMessage]) -> bool:
    last = messages[-1] if messages else None
    return (
        isinstance(last, AIMessage)
        and not last.tool_calls
        and not (last.text or "").strip()
    )


@wrap_model_call
async def retry_empty_replies(
    request: ModelRequest, handler: ModelHandler
) -> ModelResponse:
    """A blank reply is a provider hiccup: ask again, a few times."""
    response = await handler(request)
    for _ in range(EMPTY_RETRIES):
        if not blank(response.result):
            break
        print("[agent] blank reply, asking again", flush=True)
        response = await handler(request)
    return response


def model(target: Target) -> BaseChatModel:
    """The run's target as a LangChain chat model, through the trial's proxy.
    The OpenAI and Anthropic SDKs read their base URL and placeholder key
    from the environment; Gemini's is given."""
    provider, name = target["provider"], target["model"]
    effort = target.get("reasoning_effort")
    if effort == "none":
        effort = None
    if provider == "openai":
        # The Responses API, like every other driver: newer OpenAI models
        # refuse function tools with reasoning effort on chat completions.
        # `include` and `store=False` carry reasoning between calls without
        # server-side state, as the course's own payload does.
        return ChatOpenAI(
            model=name,
            use_responses_api=True,
            output_version="responses/v1",
            include=["reasoning.encrypted_content"],
            store=False,
            reasoning={"effort": effort} if effort else None,
            request_timeout=MODEL_TIMEOUT,
        )
    if provider == "anthropic":
        budget = THINKING_BUDGETS["anthropic"].get(effort or "")
        max_tokens = ANTHROPIC_MAX_TOKENS
        if budget is not None and max_tokens <= budget:
            max_tokens = budget + ANTHROPIC_MAX_TOKENS
        return ChatAnthropic(
            model=name,
            max_tokens=max_tokens,
            thinking=(
                {"type": "enabled", "budget_tokens": budget}
                if budget is not None
                else None
            ),
            default_request_timeout=MODEL_TIMEOUT,
        )
    if provider == "gemini":
        return ChatGoogleGenerativeAI(
            model=name,
            base_url=os.environ["GOOGLE_GEMINI_BASE_URL"],
            thinking_budget=THINKING_BUDGETS["gemini"].get(effort or ""),
            timeout=MODEL_TIMEOUT,
        )
    raise ValueError(f"unsupported provider {provider!r}")


def connection(server: Server) -> Connection:
    """A task MCP server, as the adapter's connection config."""
    transport = server.get("transport")
    session = {"read_timeout_seconds": TOOL_TIMEOUT}
    if transport == "streamable-http":
        return {
            "transport": "streamable_http",
            "url": server["url"],
            "session_kwargs": session,
        }
    if transport == "sse":
        return {"transport": "sse", "url": server["url"], "session_kwargs": session}
    if transport == "stdio":
        return {
            "transport": "stdio",
            "command": server["command"],
            "args": server.get("args") or [],
            "session_kwargs": session,
        }
    raise ValueError(f"unsupported MCP transport {transport!r}")


async def connect(
    stack: AsyncExitStack,
    servers: list[Server],
    hidden: Collection[str] = (),
) -> list[BaseTool]:
    """The task's tools, each bound to a session its server keeps for the
    whole trial. (Left to itself the adapter opens a session per call, and
    a benchmark's server may keep state in its session.)"""
    client = MultiServerMCPClient({s["name"]: connection(s) for s in servers})
    tools: list[BaseTool] = []
    taken: set[str] = set()
    for server in servers:
        session = await stack.enter_async_context(client.session(server["name"]))
        for tool in await load_mcp_tools(session, server_name=server["name"]):
            if tool.name in hidden:
                continue  # the harness's, not the model's
            # A name two servers share goes to the first; the second is
            # offered under its server's name. The adapter calls the MCP
            # tool by its own name whatever the model sees.
            if tool.name in taken:
                tool.name = f"{server['name']}__{tool.name}"
            taken.add(tool.name)
            tools.append(tool)
    return tools


CACHE_BUST_RESULT = json.dumps({"success": True})


def cache_bust_tool(name: str) -> BaseTool:
    """The trial's cache-bust tool, named by the course (`CC_CACHE_BUST_TOOL`):
    it opens the tool list so no two trials share a provider's cached prompt
    prefix. The model is told never to call it; a call is answered here."""

    def never_call() -> str:
        return CACHE_BUST_RESULT

    return StructuredTool.from_function(
        func=never_call, name=name, description="Never call this tool."
    )


def summary(
    messages: list[BaseMessage], max_steps: int, cache_bust: str | None
) -> dict[str, Any]:
    replies = [m for m in messages if isinstance(m, AIMessage)]
    counts = {
        # A blank reply the run gave up on is not a turn, as in base_agent.
        "turns": len(replies) - (1 if blank(messages) else 0),
        "env_tool_calls": sum(
            isinstance(m, ToolMessage) and not (cache_bust and m.name == cache_bust)
            for m in messages
        ),
    }
    if len(replies) > max_steps:
        # ModelCallLimitMiddleware ended the run with a message of its own
        # after the last model call.
        return {**counts, "turns": max_steps, "stop_reason": "max_steps"}
    if blank(messages):
        return {**counts, "stop_reason": "empty_replies"}
    return {**counts, "stop_reason": "agent_done"}


async def main() -> int:
    env = os.environ
    target: Target = json.loads(env["CC_TARGET_JSON"])
    # The runner hands over the manifest's `config` (pyproject.toml's
    # [tool.context-cup.config]) as JSON.
    config = json.loads(env.get("CC_CONFIG") or "{}")
    max_bytes = int(config.get("max_bytes", 100_000))
    max_steps = int(env.get("CC_MAX_STEPS") or 150)
    instruction = Path(env["CC_INSTRUCTION_FILE"]).read_text(encoding="utf-8")  # noqa: ASYNC240 - before any concurrent work

    result: dict[str, Any] = {"stop_reason": "agent_error"}
    messages: list[BaseMessage] = []
    try:
        async with AsyncExitStack() as stack:
            # Tools the course reserves for the harness (tau3's runtime
            # controls) are listed by the server but never offered.
            hidden = set(filter(None, env.get("CC_HARNESS_TOOLS", "").split(",")))
            tools = await connect(stack, json.loads(env["CC_MCP_SERVERS_JSON"]), hidden)
            cache_bust = env.get("CC_CACHE_BUST_TOOL")
            if cache_bust:
                tools.insert(0, cache_bust_tool(cache_bust))
            print(f"[agent] {len(tools)} tools", flush=True)
            agent = create_agent(
                model(target),
                tools,
                # The benchmark's own system prompt when it has one outside
                # the instruction (Toolathlon's: the workspace, how to finish).
                system_prompt=env.get("CC_SYSTEM_PROMPT") or SYSTEM,
                middleware=[
                    # Made here, inside the loop that uses it: a lock binds
                    # to the first loop that contends it.
                    one_at_a_time(asyncio.Lock()),
                    clip_tool_results(max_bytes),
                    retry_empty_replies,
                    ModelCallLimitMiddleware(run_limit=max_steps, exit_behavior="end"),
                ],
            )
            state = await agent.ainvoke(
                {"messages": [HumanMessage(instruction)]},
                config={"recursion_limit": NODES_PER_STEP * max_steps + 10},
            )
            messages = state["messages"]
            result.update(summary(messages, max_steps, cache_bust))
            if result["stop_reason"] == "agent_done":
                print(f"[agent] done: {messages[-1].text[:500]}", flush=True)
    finally:
        # The runner reads the counts into the trial's summary; the messages
        # are kept for whoever reads the trial afterwards.
        result["messages"] = messages_to_dict(messages)
        Path(env["CC_RESULT_FILE"]).write_text(json.dumps(result, default=str))  # noqa: ASYNC240 - after all concurrent work
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
