"""The Python engine's shape in litellm's terms: `ctx.original_messages` (the
whole record) and `ctx.context_messages` (the working copy, kept across turns
with the driver's edits) are litellm chat messages instead of native payloads.
`ctx.llm.completion(...)` calls litellm with the engine's connection: the
target model on the run's provider, pointed at the proxy with the placeholder
key, the course's tools, and the target's reasoning effort. A driver may
override any of it, call as often as it likes, and returns the litellm
response of the call that is its turn; the course gets that call's raw
provider body. OpenAI goes over the Responses API, the wire the course
speaks."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from typing import Any, cast

import httpx
import litellm
from context_cup_protocol import (
    Conversation,
    Dirs,
    Payload,
    Provider,
    ProviderInfo,
    Target,
    TurnInput,
    load_snapshot,
    save_snapshot,
    view,
)
from litellm.llms.custom_httpx.http_handler import HTTPHandler
from litellm.types.llms.openai import AllMessageValues

litellm.suppress_debug_info = True

ROUTE: dict[Provider, str] = {
    "openai": "openai/responses/",
    "anthropic": "anthropic/",
    "gemini": "gemini/",
}
# Appended to `<proxy>/t/<trial>/<provider>`; litellm adds Anthropic's /v1 itself.
VERSION: dict[Provider, str] = {"openai": "/v1", "anthropic": "", "gemini": "/v1beta"}

CONTEXT_SNAPSHOT = "litellm_context"
"""The engine's own bookkeeping in the state dir: the driver's context messages
and how many conversation messages they account for, saved per accepted turn
(see `context_cup_protocol.snapshot`). `ctx.state` stays the driver's."""

TRANSPORT: httpx.BaseTransport | None = None
"""Tests replace the network with a mock transport here."""


def gemini_signatures(payload: Payload, conversation: Conversation) -> dict[str, str]:
    """Gemini's thought signatures by the view's call id. Gemini 3 needs its
    own signatures back on its function calls to keep its reasoning between
    turns; without them litellm sends a placeholder and the model loses the
    thread. Native function-call parts and the view's calls are in the same
    order, and Gemini does not always send call ids, so they pair by position."""
    native = [
        part.get("thoughtSignature")
        for content in payload.get("contents") or []
        for part in content.get("parts") or []
        if isinstance(part, dict) and isinstance(part.get("functionCall"), dict)
    ]
    calls = [c.id for m in conversation.messages for c in m.tool_calls]
    return {
        call_id: str(signature)
        for call_id, signature in zip(calls, native, strict=False)
        if signature
    }


def chat_messages(
    conversation: Conversation,
    signatures: dict[str, str] | None = None,
    start: int = 0,
) -> list[dict[str, Any]]:
    """The conversation as chat messages. Gemini thought signatures on function
    calls ride along where litellm reads them; other opaque parts (OpenAI
    reasoning items, Anthropic thinking blocks) have no chat form and are
    dropped."""
    signatures = signatures or {}
    out: list[dict[str, Any]] = []
    if conversation.system and start == 0:
        out.append({"role": "system", "content": conversation.system})
    for m in conversation.messages[start:]:
        if m.role == "tool":
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": m.tool_call_id or "",
                    "content": m.text or "",
                }
            )
        elif m.role == "user":
            out.append({"role": "user", "content": m.text or ""})
        elif m.tool_calls or m.text:
            message: dict[str, Any] = {"role": "assistant", "content": m.text}
            if m.tool_calls:
                message["tool_calls"] = [
                    {
                        "id": c.id,
                        "type": "function",
                        "function": {
                            "name": c.name,
                            "arguments": json.dumps(c.arguments),
                        },
                        **(
                            {
                                "provider_specific_fields": {
                                    "thought_signature": signatures[c.id]
                                }
                            }
                            if c.id in signatures
                            else {}
                        ),
                    }
                    for c in m.tool_calls
                ]
            out.append(message)
    return out


def chat_tools(conversation: Conversation) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters or {"type": "object", "properties": {}},
            },
        }
        for t in conversation.tools
    ]


def route(model: str, default: Provider) -> tuple[str, Provider]:
    """A litellm model route and its provider. A bare name is the run's
    provider; a name with a provider prefix is kept as the driver wrote it."""
    for provider in ROUTE:
        if model.startswith(f"{provider}/"):
            return model, provider
    return ROUTE[default] + model, default


@dataclass
class Call:
    response: Any
    raw: Payload
    provider: Provider


class LLM:
    """The handle a driver calls: `completion` is `litellm.completion` with the
    engine's connection filled in."""

    def __init__(self, ctx: LitellmContext) -> None:
        self._ctx = ctx
        self.calls: list[Call] = []

    def api_base(self, provider: Provider) -> str:
        info = self._ctx.provider
        root = info.client.base_url.rstrip("/").rsplit(f"/{info.name}", 1)[0]
        return f"{root}/{provider}{VERSION[provider]}"

    def completion(
        self,
        messages: list[dict[str, Any]] | None = None,
        *,
        purpose: str = "turn",
        **kwargs: Any,
    ) -> Any:
        ctx = self._ctx
        model = str(kwargs.pop("model", None) or ctx.target.model)
        litellm_model, provider = route(model, ctx.provider.name)
        raws: list[Payload] = []

        def keep(response: httpx.Response) -> None:
            if response.is_success:
                response.read()
                raws.append(response.json())

        params: dict[str, Any] = {
            "model": litellm_model,
            "messages": ctx.context_messages if messages is None else messages,
            "api_base": self.api_base(provider),
            "api_key": ctx.provider.api_key,
            "drop_params": True,
            "timeout": 600,
            "client": HTTPHandler(
                client=httpx.Client(
                    transport=TRANSPORT, timeout=600, event_hooks={"response": [keep]}
                )
            ),
        }
        if ctx.tools:
            params["tools"] = ctx.tools
        effort = ctx.target.reasoning_effort
        if effort and effort != "none" and model == ctx.target.model:
            params["reasoning_effort"] = effort
        headers = {"x-cc-purpose": purpose, **(kwargs.pop("extra_headers", None) or {})}
        body = dict(kwargs.pop("extra_body", None) or {})
        if provider == "openai":
            # Nothing kept server-side, as for every other driver.
            body = {"store": False, **body}
        params.update(kwargs, extra_headers=headers)
        if body:
            params["extra_body"] = body
        response = litellm.completion(**params)
        if not raws:
            raise RuntimeError(f"no response body was captured for {litellm_model}")
        self.calls.append(Call(response, raws[-1], provider))
        return response


@dataclass
class LitellmContext:
    """What a litellm driver's `run(ctx)` receives: the conversation as
    litellm chat messages and `llm`, a litellm handle on the trial's proxy. It
    returns the response of the `llm.completion(...)` call that is its turn.

    - `context_messages`: the working copy; persists (see below).
    - `original_messages`, `tools`: the record and the course's tools in
      chat form, read only.
    - `llm`: `llm.completion()` sends `context_messages` and `tools` to the
      target; every argument can be overridden.
    - `state`: the driver's, any JSON, `{}` on turn one; persists.
    - `first`, `provider`, `target`, `dirs`, `config` (the manifest's
      `contextCup.config`), and `turn`, the whole `input.json`: read only.
    - `context_payload`, `original_payload`: the native bodies the messages
      are built from; informational.

    The engine's own bookkeeping (`context_messages` and `seen`) is kept in
    `dirs.state/litellm_context/`, one file per accepted turn.
    engines/litellm/README.md has the full table and examples."""

    turn: TurnInput
    config: dict[str, Any] = field(default_factory=dict)
    context_payload: Payload = field(init=False)
    state: Any = field(init=False)
    original_messages: list[AllMessageValues] = field(init=False)
    """The whole record as chat messages; read only."""
    context_messages: list[AllMessageValues] = field(init=False)
    """The working copy: last turn's (with the driver's edits) plus what came
    in since. What the driver leaves here is kept for the next turn, and it
    is what `ctx.llm` sends by default."""
    tools: list[dict[str, Any]] = field(init=False)
    """The course's tools in chat form, the default `ctx.llm` offers."""
    llm: LLM = field(init=False)
    seen: int = field(init=False)
    """Conversation messages `context_messages` accounts for."""

    def __post_init__(self) -> None:
        self.context_payload = copy.deepcopy(self.turn.context_payload)
        self.state = copy.deepcopy(self.turn.state)
        provider = self.turn.provider.name

        def messages(
            payload: Payload, start: int = 0
        ) -> tuple[list[AllMessageValues], Conversation]:
            conversation = view(provider, payload)
            signatures = (
                gemini_signatures(payload, conversation) if provider == "gemini" else {}
            )
            chat = chat_messages(conversation, signatures, start)
            return cast(list[AllMessageValues], chat), conversation

        self.original_messages, _ = messages(self.turn.original_payload)
        kept = load_snapshot(self.turn, CONTEXT_SNAPSHOT)
        if kept is None:
            self.context_messages, conversation = messages(self.context_payload)
        else:
            new, conversation = messages(self.context_payload, int(kept["seen"]))
            self.context_messages = [*kept["messages"], *new]
        self.seen = len(conversation.messages)
        self.tools = chat_tools(conversation)
        self.llm = LLM(self)

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


def finish(ctx: LitellmContext, result: Any) -> Payload:
    """The raw provider body of the call whose response `run` returned."""
    call = next((c for c in reversed(ctx.llm.calls) if c.response is result), None)
    if call is None:
        raise TypeError(
            "run(ctx) must return a response from ctx.llm.completion(...), "
            f"not {type(result).__name__}"
        )
    if call.provider != ctx.provider.name:
        raise TypeError(
            f"the turn's response must come from the run's provider "
            f"({ctx.provider.name}), not {call.provider}"
        )
    # Read by the next turn only if the runner accepts this one.
    save_snapshot(
        ctx.turn,
        CONTEXT_SNAPSHOT,
        {"seen": ctx.seen, "messages": ctx.context_messages},
    )
    return copy.deepcopy(call.raw)
