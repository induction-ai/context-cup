"""base_llamaindex: a whole agent on LlamaIndex, in one file.

LlamaIndex's `FunctionAgent` runs the loop: it sends the conversation to the
model, runs the tools the model asks for, appends the results, and repeats
until the model answers without calling a tool. The tools are the task's MCP
servers, turned into `FunctionTool`s by llama-index-tools-mcp over a session
this agent keeps open per server, and every model call goes through the
trial's proxy (the base URLs and the placeholder key are in the environment),
which records it. The context strategy is each tool's callback: the result
reaches the model as text clipped to `max_bytes`, like base_python and
base_agent, so the three are comparable.

Each provider's own LLM class carries what its next call needs back
(Anthropic's thinking blocks, Gemini's thought signatures); OpenAI's
encrypted reasoning is not carried. docs/protocol.md, "Agent drivers", has
everything agent.sh is handed.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Awaitable, Callable, Collection
from contextlib import AsyncExitStack
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from typing import Any, NotRequired, TypedDict

from llama_index.core.agent.workflow import AgentOutput, FunctionAgent, ToolCallResult
from llama_index.core.base.llms.types import ChatMessage, MessageRole, ToolCallBlock
from llama_index.core.llms import LLM, LLMMetadata
from llama_index.core.tools import FunctionTool
from llama_index.llms.anthropic import Anthropic
from llama_index.tools.mcp import McpToolSpec
from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamablehttp_client
from mcp.types import CallToolResult
from workflows.errors import WorkflowRuntimeError

SYSTEM = (
    "You are an autonomous agent. Work the task below with the tools you are "
    "given, calling as many as you need. When the task is complete, reply with "
    "a short final answer and no tool calls."
)
MARKER = "\n\n[truncated by base_llamaindex: {dropped} bytes removed]"
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
# Given to the Gemini client so it needn't fetch the model's metadata.
GEMINI_MAX_TOKENS = 65_536
# What each LLM class reports as its model's context window. The library
# looks a name up in a table of its own and raises on one it has not seen
# (a dated snapshot, the next model), and the agent only reads the window
# to size its memory buffer, so every model gets its family's.
CONTEXT_WINDOWS = {"openai": 400_000, "anthropic": 200_000, "gemini": 1_048_576}


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


def result_text(result: CallToolResult) -> str:
    """An MCP tool result as text. A failure is text too: the model reads it
    and decides what to do."""
    parts = [
        item.text if hasattr(item, "text") else json.dumps(item.model_dump(mode="json"))
        for item in result.content
    ]
    if not parts and result.structuredContent is not None:
        parts.append(json.dumps(result.structuredContent))
    text = "\n".join(parts)
    return f"Error: {text}" if result.isError else text


ToolCall = Callable[..., Awaitable[CallToolResult]]


def one_at_a_time(call: ToolCall, lock: asyncio.Lock) -> ToolCall:
    """A turn's tool calls run in order, as the course's own loop runs
    them: tau3's runtime logs each call for its verifier, and calls made
    concurrently interleave the log, which fails the trial's scoring."""

    async def in_turn(**arguments: Any) -> CallToolResult:
        async with lock:
            return await call(**arguments)

    return in_turn


def clipped(name: str, max_bytes: int) -> Callable[[CallToolResult], Awaitable[str]]:
    """The context strategy, as a tool's callback: LlamaIndex hands it the
    raw MCP result, and the string it returns is what the model sees."""

    async def callback(result: CallToolResult) -> str:
        text = result_text(result)
        print(f"[agent] {name} -> {len(text)} chars", flush=True)
        return clip(text, max_bytes)

    return callback


async def session_for(stack: AsyncExitStack, server: Server) -> ClientSession:
    """One session per server for the whole trial, as the course's own loop
    keeps: a benchmark's server may keep state in it."""
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
    return session


async def connect(
    stack: AsyncExitStack,
    servers: list[Server],
    hidden: Collection[str],
    max_bytes: int,
    lock: asyncio.Lock,
) -> list[FunctionTool]:
    """The task's tools as `FunctionTool`s, each clipping its result and
    taking its turn on `lock`."""
    tools: list[FunctionTool] = []
    taken: set[str] = set()
    for server in servers:
        session = await session_for(stack, server)
        for tool in await McpToolSpec(client=session).to_tool_list_async():
            name = tool.metadata.name or ""
            if name in hidden:
                continue  # the harness's, not the model's
            # A name two servers share goes to the first; the second is
            # offered under its server's name. The tool spec calls the MCP
            # tool by its own name whatever the model sees.
            if name in taken:
                name = f"{server['name']}__{name}"
            taken.add(name)
            tools.append(
                FunctionTool.from_defaults(
                    async_fn=one_at_a_time(tool.async_fn, lock),
                    tool_metadata=replace(tool.metadata, name=name),
                    async_callback=clipped(name, max_bytes),
                )
            )
    return tools


class AnthropicLLM(Anthropic):
    """LlamaIndex's Anthropic LLM with the window from `CONTEXT_WINDOWS`:
    unlike the OpenAI class it has no field for one and raises on a model
    name outside its table."""

    @property
    def metadata(self) -> LLMMetadata:
        return LLMMetadata(
            context_window=CONTEXT_WINDOWS["anthropic"],
            num_output=self.max_tokens,
            is_chat_model=True,
            is_function_calling_model=True,
            model_name=self.model,
        )


def model(target: Target) -> LLM:
    """The run's target as a LlamaIndex LLM, through the trial's proxy: each
    client is given the proxy's base URL and the placeholder key."""
    provider, name = target["provider"], target["model"]
    effort = target.get("reasoning_effort")
    if effort == "none":
        effort = None
    env = os.environ
    if provider == "openai":
        from llama_index.llms.openai import OpenAIResponses

        # The Responses API, like every other driver: newer OpenAI models
        # refuse function tools with reasoning effort on chat completions.
        # `reasoning_options` is only sent for models the library knows (and
        # drops the sampling parameters they refuse); `additional_kwargs`
        # sends it whatever the model.
        reasoning = {"effort": effort} if effort else None
        return OpenAIResponses(
            model=name,
            context_window=CONTEXT_WINDOWS["openai"],
            api_base=env["OPENAI_BASE_URL"],
            api_key=env["OPENAI_API_KEY"],
            reasoning_options=reasoning,
            additional_kwargs={"reasoning": reasoning} if reasoning else None,
            timeout=MODEL_TIMEOUT,
        )
    if provider == "anthropic":
        budget = THINKING_BUDGETS["anthropic"].get(effort or "")
        max_tokens = ANTHROPIC_MAX_TOKENS
        if budget is not None and max_tokens <= budget:
            max_tokens = budget + ANTHROPIC_MAX_TOKENS
        return AnthropicLLM(
            model=name,
            base_url=env["ANTHROPIC_BASE_URL"],
            api_key=env["ANTHROPIC_API_KEY"],
            max_tokens=max_tokens,
            # Thinking allows no other temperature.
            temperature=1.0,
            thinking_dict=(
                {"type": "enabled", "budget_tokens": budget}
                if budget is not None
                else None
            ),
            timeout=MODEL_TIMEOUT,
        )
    if provider == "gemini":
        from google.genai import types
        from llama_index.llms.google_genai import GoogleGenAI

        budget = THINKING_BUDGETS["gemini"].get(effort or "")
        return GoogleGenAI(
            model=name,
            api_key=env["GEMINI_API_KEY"],
            http_options={"base_url": env["GOOGLE_GEMINI_BASE_URL"]},
            max_tokens=GEMINI_MAX_TOKENS,
            context_window=CONTEXT_WINDOWS["gemini"],
            generation_config=(
                types.GenerateContentConfig(
                    thinking_config=types.ThinkingConfig(thinking_budget=budget)
                )
                if budget is not None
                else None
            ),
        )
    raise ValueError(f"unsupported provider {provider!r}")


def blank(message: ChatMessage) -> bool:
    """A reply with neither text nor a tool call. (Each provider's LLM class
    keeps tool calls its own way: as blocks, or in `additional_kwargs`.)"""
    return (
        not (message.content or "").strip()
        and not any(isinstance(block, ToolCallBlock) for block in message.blocks)
        and not message.additional_kwargs.get("tool_calls")
    )


async def work(
    agent: FunctionAgent, instruction: str, max_steps: int, result: dict[str, Any]
) -> list[ChatMessage]:
    """Run the agent on the task, counting its steps as they stream by, and
    return its memory: the conversation as it ended."""
    history: list[ChatMessage] = []
    run: dict[str, Any] = {"user_msg": instruction}
    for _ in range(EMPTY_RETRIES + 1):
        # The cap is checked as each reply is parsed and stops the run at
        # the reply that reaches it, so the model is called `max_steps` times
        # and the last reply's tool calls are not run. A retry gets what is
        # left of the budget, not a fresh one.
        remaining = max_steps - result["turns"]
        if remaining <= 0:
            result["stop_reason"] = "max_steps"
            return history
        handler = agent.run(**run, max_iterations=remaining)
        stopped = False
        try:
            async for event in handler.stream_events():
                if isinstance(event, ToolCallResult):
                    result["env_tool_calls"] += 1
                elif isinstance(event, AgentOutput) and not blank(event.response):
                    result["turns"] += 1
            await handler
        except WorkflowRuntimeError as exc:
            if "Max iterations" not in str(exc):
                raise
            stopped = True
        memory = await handler.ctx.store.get("memory")
        history = await memory.aget_all()
        if stopped:
            result["stop_reason"] = "max_steps"
            return history
        last = history[-1] if history else None
        if last is not None and last.role == MessageRole.ASSISTANT and not blank(last):
            result["stop_reason"] = "agent_done"
            print(f"[agent] done: {(last.content or '')[:500]}", flush=True)
            return history
        # A blank reply is a provider hiccup: ask again, from the
        # conversation without it.
        print("[agent] blank reply, asking again", flush=True)
        while history and history[-1].role == MessageRole.ASSISTANT:
            history.pop()
        run = {"chat_history": history}
    result["stop_reason"] = "empty_replies"
    return history


async def main() -> int:
    env = os.environ
    target: Target = json.loads(env["CC_TARGET_JSON"])
    # The runner hands over the manifest's `config` (pyproject.toml's
    # [tool.context-cup.config]) as JSON.
    config = json.loads(env.get("CC_CONFIG") or "{}")
    max_bytes = int(config.get("max_bytes", 100_000))
    max_steps = int(env.get("CC_MAX_STEPS") or 150)
    instruction = Path(env["CC_INSTRUCTION_FILE"]).read_text(encoding="utf-8")  # noqa: ASYNC240 - before any concurrent work

    result: dict[str, Any] = {
        "stop_reason": "agent_error",
        "turns": 0,
        "env_tool_calls": 0,
    }
    messages: list[ChatMessage] = []
    try:
        async with AsyncExitStack() as stack:
            # Tools the course reserves for the harness (tau3's runtime
            # controls) are listed by the server but never offered.
            hidden = set(filter(None, env.get("CC_HARNESS_TOOLS", "").split(",")))
            tools = await connect(
                stack,
                json.loads(env["CC_MCP_SERVERS_JSON"]),
                hidden,
                max_bytes,
                # Made here, inside the loop that uses it: a lock binds to
                # the first loop that contends it.
                asyncio.Lock(),
            )
            print(f"[agent] {len(tools)} tools", flush=True)
            agent = FunctionAgent(
                tools=list(tools),
                llm=model(target),
                # The benchmark's own system prompt when it has one outside
                # the instruction (Toolathlon's: the workspace, how to finish).
                system_prompt=env.get("CC_SYSTEM_PROMPT") or SYSTEM,
                streaming=False,
            )
            messages = await work(agent, instruction, max_steps, result)
    finally:
        # The runner reads the counts into the trial's summary; the messages
        # are kept for whoever reads the trial afterwards.
        result["messages"] = [m.model_dump(mode="json") for m in messages]
        Path(env["CC_RESULT_FILE"]).write_text(json.dumps(result, default=str))  # noqa: ASYNC240 - after all concurrent work
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
