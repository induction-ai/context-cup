"""tau3-bench environment: the task's tau3-runtime MCP sidecar hosts the user
simulator and the domain tools. The assistant either sends the user a message
or makes tool calls; the runtime answers with the user's reply, tool results,
and a termination reason when the conversation ends.

Settings:
  CC_TAU3_MCP_URL          streamable-http URL of the runtime sidecar
  CC_INSTRUCTION_FILE      harbor's instruction; the <policy> block is used
  CC_TAU3_SEED             user-simulator seed (int) or unset
  CC_TAU3_MAX_ERRORS       runtime error budget, default 10
  CC_MAX_STEPS             also handed to the runtime's configure_run
  CC_TOOL_TIMEOUT_SEC      per MCP call, default 120

Tool results reach the driver whole; what to keep of a long one is the
driver's call.
"""

from __future__ import annotations

import json
import re
from contextlib import AsyncExitStack
from datetime import timedelta
from pathlib import Path
from typing import Any

from context_cup_protocol import ToolCallRef, Utterance

from ..environment import EnvironmentStart, StepResult, ToolResult
from ..mcp_util import mcp_tool_to_function_tool, result_text

FIRST_AGENT_MESSAGE = "Hi! How can I help you today?"
USER_STOP_TOKENS = ("###STOP###", "###TRANSFER###", "###OUT-OF-SCOPE###")

ORCHESTRATION_TOOL_NAMES = frozenset(
    {
        "configure_run",
        "get_runtime_status",
        "get_assistant_tool_schemas",
        "start_conversation",
        "submit_assistant_message",
        "submit_assistant_tool_calls",
        "send_message_to_user",
        "end_conversation",
        "record_termination",
    }
)
"""The runtime's own controls, listed beside the domain tools; never offered
to the model."""

AGENT_FACING_TOOL_NAMES = frozenset(
    {"start_conversation", "send_message_to_user", "end_conversation"}
)
"""The controls harbor's instruction tells a whole agent to use: it talks to
the user through tools instead of through the harness."""

HARNESS_TOOL_NAMES = ORCHESTRATION_TOOL_NAMES - AGENT_FACING_TOOL_NAMES
"""The controls only a harness may call. A whole agent that calls one (say
configure_run) undoes the trial's setup, so it is told not to offer them."""

TAU2_TERMINATION_REASONS = frozenset(
    {
        "user_stop",
        "agent_stop",
        "max_steps",
        "too_many_errors",
        "agent_error",
        "user_error",
    }
)
"""What the runtime's record_termination accepts (tau2's TerminationReason).
Any other way the trial ended (a runner or environment failure) is recorded
as `agent_error`."""


def tau2_termination_reason(stop_reason: str) -> str:
    return stop_reason if stop_reason in TAU2_TERMINATION_REASONS else "agent_error"


def assistant_tool_schemas(listed: list[Any]) -> list[dict[str, Any]]:
    """The MCP listing as function schemas, the runtime's controls left out."""
    return [
        mcp_tool_to_function_tool(tool)
        for tool in listed
        if getattr(tool, "name", None) not in ORCHESTRATION_TOOL_NAMES
    ]


AGENT_INSTRUCTION = """\
You are a customer service agent that helps the user according to the <policy> provided below.
In each turn you can either:
- Send a message to the user.
- Make a tool call.
You cannot do both at the same time.

Try to be helpful and always follow the policy. Always make sure you generate valid JSON only."""


def extract_policy(instruction: str) -> str:
    match = re.search(
        r"</instructions>\s*<policy>\s*(.*?)\s*</policy>\s*$",
        instruction,
        flags=re.DOTALL,
    )
    if match:
        return match.group(1).strip()
    matches: list[str] = re.findall(
        r"<policy>\s*(.*?)\s*</policy>", instruction, flags=re.DOTALL
    )
    if matches:
        return matches[-1].strip()
    return instruction.strip()


def system_prompt(policy: str) -> str:
    return f"<instructions>\n{AGENT_INSTRUCTION}\n</instructions>\n<policy>\n{policy}\n</policy>"


def is_user_stop(text: str) -> bool:
    return any(token in text for token in USER_STOP_TOKENS)


class Tau3Environment:
    name = "tau3"
    fail_at_max_steps = False

    def __init__(
        self,
        *,
        mcp_url: str,
        instruction: str,
        seed: int | None,
        max_steps: int,
        max_errors: int = 10,
        tool_timeout_sec: float = 120.0,
    ):
        self.mcp_url = mcp_url
        self.instruction = instruction
        self.seed = seed
        self.max_steps = max_steps
        self.max_errors = max_errors
        self.tool_timeout = timedelta(seconds=tool_timeout_sec)
        self._stack = AsyncExitStack()
        self._session: Any = None
        self.step_count = 0
        self.num_errors = 0
        self.terminated: str | None = None

    @classmethod
    def from_env(cls, env: dict[str, str]) -> Tau3Environment:
        seed_raw = env.get("CC_TAU3_SEED")
        return cls(
            mcp_url=env["CC_TAU3_MCP_URL"],
            instruction=Path(env["CC_INSTRUCTION_FILE"]).read_text(encoding="utf-8"),
            seed=int(seed_raw) if seed_raw not in (None, "", "none") else None,
            max_steps=int(env.get("CC_MAX_STEPS") or 200),
            max_errors=int(env.get("CC_TAU3_MAX_ERRORS") or 10),
            tool_timeout_sec=float(env.get("CC_TOOL_TIMEOUT_SEC") or 120.0),
        )

    # -- MCP plumbing ------------------------------------------------------

    async def _connect(self) -> None:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        read, write, _ = await self._stack.enter_async_context(
            streamablehttp_client(
                self.mcp_url,
                timeout=self.tool_timeout,
                sse_read_timeout=self.tool_timeout,
            )
        )
        self._session = await self._stack.enter_async_context(
            ClientSession(read, write, read_timeout_seconds=self.tool_timeout)
        )
        await self._session.initialize()

    async def _call_text(
        self, name: str, arguments: dict[str, Any] | None = None
    ) -> str:
        result = await self._session.call_tool(
            name, arguments or {}, read_timeout_seconds=self.tool_timeout
        )
        return result_text(result)

    async def _call_json(
        self, name: str, arguments: dict[str, Any] | None = None
    ) -> Any:
        return json.loads(await self._call_text(name, arguments))

    def _absorb_status(self, status: dict[str, Any]) -> None:
        if isinstance(status.get("step_count"), int):
            self.step_count = status["step_count"]
        if isinstance(status.get("num_errors"), int):
            self.num_errors = status["num_errors"]
        reason = status.get("termination_reason")
        if isinstance(reason, str) and reason:
            self.terminated = reason

    # -- Environment protocol ---------------------------------------------

    async def _configure(self) -> None:
        """The run's seed and caps, before the conversation starts."""
        try:
            status = await self._call_json(
                "configure_run",
                {
                    "seed": self.seed,
                    "max_steps": self.max_steps,
                    "max_errors": self.max_errors,
                },
            )
            if isinstance(status, dict):
                self._absorb_status(status)
        except Exception as exc:  # noqa: BLE001 - older runtimes have no configure_run
            print(f"[runner] configure_run unavailable: {exc}", flush=True)

    async def configure_for_agent(self) -> None:
        """Configure the runtime as open() does, and leave the conversation to
        a whole agent: it calls start_conversation itself."""
        await self._connect()
        try:
            await self._configure()
        finally:
            await self._stack.aclose()

    async def open(self) -> EnvironmentStart:
        await self._connect()
        listed = await self._session.list_tools()
        tools = await self._assistant_tools(listed.tools)
        await self._configure()
        opening = await self._call_text("start_conversation")
        try:
            status = await self._call_json("get_runtime_status")
            if isinstance(status, dict):
                self._absorb_status(status)
        except Exception as exc:  # noqa: BLE001
            print(f"[runner] get_runtime_status unavailable: {exc}", flush=True)
        stop = self.terminated or ("user_stop" if is_user_stop(opening) else None)
        return EnvironmentStart(
            system=system_prompt(extract_policy(self.instruction)),
            opening=[
                Utterance("assistant", FIRST_AGENT_MESSAGE),
                Utterance("user", opening),
            ],
            tools=tools,
            stop_reason=stop,
        )

    async def _assistant_tools(self, listed: list[Any]) -> list[dict[str, Any]]:
        try:
            schemas = await self._call_json("get_assistant_tool_schemas")
        except Exception as exc:  # noqa: BLE001 - fall back to the listing
            print(f"[runner] get_assistant_tool_schemas unavailable: {exc}", flush=True)
            return assistant_tool_schemas(listed)
        if not isinstance(schemas, list):
            raise TypeError("get_assistant_tool_schemas must return a JSON list")
        if not schemas:
            # A runtime that has not set its domain up yet answers []; a trial
            # without tools would score 0 without any error.
            print(
                "[runner] get_assistant_tool_schemas returned no tools; "
                "using the MCP listing",
                flush=True,
            )
            return assistant_tool_schemas(listed)
        return schemas

    async def on_tool_calls(
        self, tool_calls: list[ToolCallRef], text: str | None
    ) -> StepResult:
        payload = [
            {"id": call.id, "name": call.name, "arguments": call.arguments}
            for call in tool_calls
        ]
        response = await self._call_json(
            "submit_assistant_tool_calls",
            {"tool_calls_json": json.dumps(payload), "content": text},
        )
        if not isinstance(response, dict):
            raise TypeError("submit_assistant_tool_calls returned a non-object")
        self._absorb_status(response)
        results = [
            ToolResult(
                tool_call_id=str(item.get("id", "")),
                content=str(item.get("content") or ""),
            )
            for item in response.get("tool_results") or []
        ]
        return StepResult(
            tool_results=results, stop_reason=self.terminated, extra=self._extra()
        )

    async def on_message(self, text: str) -> StepResult:
        response = await self._call_json("submit_assistant_message", {"message": text})
        if not isinstance(response, dict):
            raise TypeError("submit_assistant_message returned a non-object")
        self._absorb_status(response)
        user_messages = []
        observation = response.get("observation")
        if isinstance(observation, str) and observation:
            user_messages.append(observation)
        return StepResult(
            user_messages=user_messages,
            stop_reason=self.terminated,
            extra=self._extra(),
        )

    async def close(self, stop_reason: str) -> dict[str, Any]:
        try:
            if self._session is not None and self.terminated is None:
                try:
                    status = await self._call_json(
                        "record_termination",
                        {"reason": tau2_termination_reason(stop_reason)},
                    )
                    if isinstance(status, dict):
                        self._absorb_status(status)
                except Exception as exc:  # noqa: BLE001 - the runtime may already be gone
                    print(f"[runner] record_termination failed: {exc}", flush=True)
        finally:
            await self._stack.aclose()
        return self._extra()

    def _extra(self) -> dict[str, Any]:
        return {"tau3_step_count": self.step_count, "tau3_num_errors": self.num_errors}
