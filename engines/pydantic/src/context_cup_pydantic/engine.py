"""A Pydantic driver's `run(ctx)` returns Pydantic AI (Harness) capabilities,
or a whole `Agent`. `finish` runs the turn with it: the connection is always
the engine's (the model on the proxy, keeping a model name the driver chose,
else the target), the course's tools are added as external tools, and the
saved history, new tool results, and user text go in. Everything else the
driver set is kept. It returns the provider response behind the agent's
move."""

from __future__ import annotations

import copy
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

import httpx2
from context_cup_protocol import Dirs, Payload, ProviderInfo, Target, TurnInput, view
from openai.types.shared import ReasoningEffort
from pydantic_ai import (
    Agent,
    DeferredToolRequests,
    DeferredToolResults,
    ExternalToolset,
)
from pydantic_ai.agent import AgentRunResult
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIResponsesModel, OpenAIResponsesModelSettings
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.tools import ToolDefinition

HISTORY = "pydantic_history.json"


@dataclass
class PydanticContext:
    turn: TurnInput
    config: dict[str, Any] = field(default_factory=dict)
    http_client: httpx2.AsyncClient = field(
        default_factory=lambda: httpx2.AsyncClient(
            timeout=httpx2.Timeout(600, connect=10)
        )
    )
    context_payload: Payload = field(init=False)
    state: Any = field(init=False)

    def __post_init__(self) -> None:
        self.context_payload = copy.deepcopy(self.turn.context_payload)
        self.state = copy.deepcopy(self.turn.state)

    @property
    def first(self) -> bool:
        return self.turn.first

    @property
    def provider(self) -> ProviderInfo:
        return self.turn.provider

    @property
    def target(self) -> Target:
        return self.turn.target

    @property
    def dirs(self) -> Dirs:
        return self.turn.dirs

    @property
    def original_payload(self) -> Payload:
        return self.turn.original_payload


def finish(ctx: PydanticContext, result: Any) -> Payload:
    if isinstance(result, Agent):
        agent: Agent[Any, Any] = result
    elif isinstance(result, Sequence) and not isinstance(result, str):
        agent = Agent(capabilities=list(result))
    else:
        raise TypeError(
            "run(ctx) must return Pydantic AI capabilities or an Agent, "
            f"not {type(result).__name__}"
        )
    if ctx.provider.name != "openai":
        raise ValueError(
            f"engine-pydantic supports openai only, not {ctx.provider.name}"
        )

    conversation = view(ctx.provider.name, ctx.context_payload)
    history_file = Path(ctx.dirs.state) / HISTORY
    seen = 0 if ctx.first else int((ctx.state or {}).get("seen", 0))
    history: list[ModelMessage] = (
        []
        if ctx.first
        else list(ModelMessagesTypeAdapter.validate_json(history_file.read_bytes()))
    )
    prompts: list[str] = []
    results: dict[str, Any] = {}
    for message in conversation.messages[seen:]:
        if message.role == "user":
            prompts.append(message.text or "")
        elif message.role == "tool":
            results[message.tool_call_id or ""] = message.text or ""
        elif ctx.first:  # the environment's canned opening, before the task
            if prompts:
                history.append(
                    ModelRequest(parts=[UserPromptPart("\n\n".join(prompts))])
                )
                prompts = []
            history.append(ModelResponse(parts=[TextPart(message.text or "")]))

    responses: list[Payload] = []

    async def keep(response: httpx2.Response) -> None:
        if response.request.url.path.endswith("/responses") and response.is_success:
            await response.aread()
            responses.append(response.json())

    ctx.http_client.event_hooks["response"].append(keep)
    own = agent.model
    name = own.model_name if isinstance(own, Model) else str(own or "").split(":")[-1]
    effort = ctx.target.reasoning_effort
    run: AgentRunResult[Any] = agent.run_sync(
        "\n\n".join(p for p in prompts if p) or None,
        model=OpenAIResponsesModel(
            name or ctx.target.model,
            provider=OpenAIProvider(
                base_url=ctx.provider.client.base_url,
                api_key=ctx.provider.api_key,
                http_client=ctx.http_client,
            ),
        ),
        # Private in pydantic-ai 2.48: whether the agent has instructions of its own.
        instructions=None
        if getattr(agent, "_instructions", None)
        else conversation.system,
        toolsets=[
            ExternalToolset(
                [
                    ToolDefinition(
                        name=t.name,
                        description=t.description,
                        parameters_json_schema=t.parameters,
                    )
                    for t in conversation.tools
                ]
            )
        ],
        output_type=[str, DeferredToolRequests],
        model_settings=OpenAIResponsesModelSettings(
            openai_reasoning_effort=cast(ReasoningEffort, effort)
        )
        if not name and effort and effort != "none"
        else None,
        message_history=history or None,
        deferred_tool_results=DeferredToolResults(calls=results) if results else None,
    )
    if not responses:
        raise RuntimeError("the agent made no successful Responses call this turn")
    history_file.write_bytes(ModelMessagesTypeAdapter.dump_json(run.all_messages()))
    ctx.state = {"seen": len(conversation.messages)}
    return responses[-1]
