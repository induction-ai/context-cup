"""The LiteLLM engine's shape on the AI SDK for Python: `ctx.original_messages`
(the whole record) and `ctx.context_messages` (the working copy, kept across
turns with the driver's edits) are AI SDK `Message`s instead of native
payloads. `ctx.llm.generate(...)` calls the SDK with the engine's connection:
the target model on the run's provider, pointed at the proxy with the
placeholder key, the course's tools, and the target's reasoning settings as
the course set them. A driver may override any of it, call as often as it
likes, and returns the message of the call that is its turn; the course gets
that call's raw provider body. OpenAI goes over the Responses API, the wire
the course speaks.

The SDK only streams, so the raw body is rebuilt from the stream the
provider sent: OpenAI's final event carries the whole response, and
Anthropic's SDK accumulates its events into one."""

from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, cast

import ai
import httpx2
import pydantic
from ai.providers.openai import OpenAIParams
from ai.types.messages import Message
from anthropic.types import RawMessageStreamEvent

from context_cup_protocol import (
    Dirs,
    Payload,
    Provider,
    ProviderInfo,
    Target,
    TurnInput,
    load_snapshot,
    route,
    save_snapshot,
    trial_root,
    view,
)

from .messages import model_messages, model_tools

# Appended to `<proxy>/t/<trial>/<provider>`: where each SDK client expects
# its API version in the base URL (the Anthropic client adds /v1 itself).
VERSION: dict[Provider, str] = {"openai": "/v1", "anthropic": "", "gemini": "/v1beta"}

CONTEXT_SNAPSHOT = "aisdk_context"
"""The engine's own bookkeeping in the state dir: the driver's context
messages and how many conversation messages they account for, saved per
accepted turn (see `context_cup_protocol.snapshot`). `ctx.state` stays the
driver's."""

TRANSPORT: httpx2.AsyncBaseTransport | None = None
"""Tests replace the network with a mock transport here."""

TIMEOUT = 600

ANTHROPIC_EVENT: pydantic.TypeAdapter[RawMessageStreamEvent] = pydantic.TypeAdapter(
    RawMessageStreamEvent
)


def target_params(provider: Provider, payload: Payload) -> ai.InferenceRequestParams:
    """Call settings the course put in the target's native payload, as SDK
    params: OpenAI's reasoning effort and summary and what to include,
    Anthropic's thinking and max_tokens. `store: false` on OpenAI, as for
    every other driver."""
    if provider == "openai":
        reasoning = payload.get("reasoning") or {}
        output: dict[str, Any] = {}
        if payload.get("include"):
            output["include"] = frozenset(payload["include"])
        if reasoning.get("summary"):
            output["reasoning_summary"] = reasoning["summary"]
        return ai.InferenceRequestParams(
            reasoning=(
                ai.ReasoningParams(effort=reasoning["effort"])
                if reasoning.get("effort")
                else ai.DEFAULT
            ),
            output=ai.OutputParams(**output) if output else None,
            provider_params={OpenAIParams: OpenAIParams(store=False)},
        )
    if provider == "anthropic":
        # The SDK's own thinking knob is adaptive effort; the payload's
        # budget goes in the body as the course wrote it.
        return ai.InferenceRequestParams(
            output=(
                ai.OutputParams(max_tokens=int(payload["max_tokens"]))
                if payload.get("max_tokens")
                else None
            ),
            extra_body=(
                {"thinking": payload["thinking"]} if payload.get("thinking") else None
            ),
        )
    raise ValueError(f"the AI SDK for Python has no {provider} provider")


class Tee(httpx2.AsyncByteStream):
    """A response stream copied into `sink` as it is read."""

    def __init__(self, inner: httpx2.AsyncByteStream, sink: bytearray) -> None:
        self._inner = inner
        self._sink = sink

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._inner:
            self._sink.extend(chunk)
            yield chunk

    async def aclose(self) -> None:
        await self._inner.aclose()


class Capture(httpx2.AsyncBaseTransport):
    """The transport the SDK clients send through: every successful
    response's body is kept, streamed or not."""

    def __init__(
        self, inner: httpx2.AsyncBaseTransport, bodies: list[bytearray]
    ) -> None:
        self._inner = inner
        self._bodies = bodies

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        response = await self._inner.handle_async_request(request)
        if response.is_success:
            sink = bytearray()
            self._bodies.append(sink)
            if response.is_stream_consumed:
                # A body given whole (a mock transport's) is already read.
                sink.extend(response.content)
            else:
                # An async transport's responses stream asynchronously.
                response.stream = Tee(
                    cast(httpx2.AsyncByteStream, response.stream), sink
                )
        return response

    async def aclose(self) -> None:
        await self._inner.aclose()


def events(body: bytes) -> list[Payload]:
    """The JSON of each event in a server-sent event stream."""
    out: list[Payload] = []
    for block in body.decode("utf-8").split("\n\n"):
        data = [
            line[5:].strip() for line in block.split("\n") if line.startswith("data:")
        ]
        if data:
            out.append(json.loads("\n".join(data)))
    return out


def raw_body(provider: Provider, body: bytes) -> Payload:
    """The provider's response as a non-streaming call would return it."""
    if body.lstrip().startswith(b"{"):
        parsed: Payload = json.loads(body)
        return parsed
    stream = events(body)
    if provider == "openai":
        final = [
            e["response"]
            for e in stream
            if e.get("type")
            in ("response.completed", "response.incomplete", "response.failed")
        ]
        if not final:
            raise RuntimeError("the OpenAI stream ended without a final response")
        response: Payload = final[-1]
        return response
    # The Anthropic SDK's own accumulator, the one behind its stream's
    # `get_final_message`; private, so loaded only on this path, where a
    # rename would fail Anthropic turns alone.
    from anthropic.lib.streaming._messages import accumulate_event

    snapshot = None
    buffers: dict[int, bytes] = {}
    for event in stream:
        if event.get("type") == "ping":
            continue
        snapshot = accumulate_event(
            event=ANTHROPIC_EVENT.validate_python(event),
            current_snapshot=snapshot,
            json_bufs=buffers,
        )
    if snapshot is None:
        raise RuntimeError("the Anthropic stream ended without a message")
    return snapshot.model_dump(mode="json", exclude_unset=True)


@dataclass
class Call:
    message: Message
    raw: Payload
    provider: Provider


class LLM:
    """The handle a driver calls: `generate` is the SDK's with the engine's
    connection filled in."""

    def __init__(self, ctx: AisdkContext) -> None:
        self._ctx = ctx
        self.calls: list[Call] = []

    def base(self, provider: Provider) -> str:
        return f"{trial_root(self._ctx.provider)}/{provider}{VERSION[provider]}"

    def generate(
        self,
        messages: Sequence[Message] | None = None,
        *,
        model: str | None = None,
        tools: Sequence[ai.Tool] | None = None,
        params: ai.InferenceRequestParams | None = None,
        purpose: str = "turn",
    ) -> Message:
        """One call, with the run's defaults: `ctx.context_messages`,
        `ctx.tools` (pass `[]` for none), the target model, and, on the
        target, the reasoning settings the course chose for it. `params`
        replaces those settings; `store` stays off on OpenAI either way."""
        return asyncio.run(
            self._generate(
                messages, model=model, tools=tools, params=params, purpose=purpose
            )
        )

    async def _generate(
        self,
        messages: Sequence[Message] | None,
        *,
        model: str | None,
        tools: Sequence[ai.Tool] | None,
        params: ai.InferenceRequestParams | None,
        purpose: str,
    ) -> Message:
        ctx = self._ctx
        provider, name = route(model or ctx.target.model, ctx.provider.name)
        if provider not in ("openai", "anthropic"):
            raise ValueError(f"the AI SDK for Python has no {provider} provider")
        on_target = provider == ctx.provider.name and name == ctx.target.model
        if params is None:
            params = (
                target_params(provider, ctx.context_payload)
                if on_target
                else ai.InferenceRequestParams()
            )
        if provider == "openai":
            # Nothing kept server-side, as for every other driver.
            params = ai.InferenceRequestParams(
                **{
                    **params.__dict__,
                    "provider_params": {
                        **(params.provider_params or {}),
                        OpenAIParams: OpenAIParams(store=False),
                    },
                }
            )
        bodies: list[bytearray] = []
        transport = Capture(TRANSPORT or httpx2.AsyncHTTPTransport(), bodies)
        async with httpx2.AsyncClient(transport=transport, timeout=TIMEOUT) as http:
            sdk_provider = ai.get_provider(
                provider,
                base_url=self.base(provider),
                api_key=ctx.provider.api_key,
                headers={"x-cc-purpose": purpose},
                client=http,
            )
            message = await ai.experimental_generate(
                ai.Model(id=name, provider=sdk_provider),
                list(ctx.context_messages if messages is None else messages),
                tools=list(ctx.tools if tools is None else tools) or None,
                params=params,
            )
        if not bodies:
            raise RuntimeError(f"no response body was captured for {name}")
        self.calls.append(
            Call(message, raw_body(provider, bytes(bodies[-1])), provider)
        )
        return message


@dataclass
class AisdkContext:
    """What an AI SDK driver's `run(ctx)` receives: the conversation as SDK
    messages and `llm`, an SDK handle on the trial's proxy. It returns the
    message of the `llm.generate(...)` call that is its turn.

    - `context_messages`: the working copy; persists (see below).
    - `original_messages`, `tools`: the record and the course's tools in
      SDK form, read only.
    - `llm`: `llm.generate()` sends `context_messages` and `tools` to the
      target; every argument can be overridden.
    - `state`: the driver's, any JSON, `{}` on turn one; persists.
    - `first`, `provider`, `target`, `dirs`, `config` (the manifest's
      `[tool.context-cup.config]`), and `turn`, the whole `input.json`: read only.
    - `context_payload`, `original_payload`: the native bodies the messages
      are built from; informational.

    The engine's own bookkeeping (`context_messages` and `seen`) is kept in
    `dirs.state/aisdk_context/`, one file per accepted turn.
    engines/aisdk_python/README.md has the full table and examples."""

    turn: TurnInput
    config: dict[str, Any] = field(default_factory=dict)
    context_payload: Payload = field(init=False)
    state: Any = field(init=False)
    original_messages: list[Message] = field(init=False)
    """The whole record as SDK messages; read only."""
    context_messages: list[Message] = field(init=False)
    """The working copy: last turn's (with the driver's edits) plus what came
    in since. What the driver leaves here is kept for the next turn, and it
    is what `ctx.llm` sends by default."""
    tools: list[ai.Tool] = field(init=False)
    """The course's tools in SDK form, the default `ctx.llm` offers."""
    llm: LLM = field(init=False)
    seen: int = field(init=False)
    """Conversation messages `context_messages` accounts for."""

    def __post_init__(self) -> None:
        self.context_payload = copy.deepcopy(self.turn.context_payload)
        self.state = copy.deepcopy(self.turn.state)
        provider = self.turn.provider.name
        self.original_messages = model_messages(
            provider, view(provider, self.turn.original_payload)
        )
        conversation = view(provider, self.context_payload)
        kept = load_snapshot(self.turn, CONTEXT_SNAPSHOT)
        if kept is None:
            self.context_messages = model_messages(provider, conversation)
        else:
            self.context_messages = [
                *(Message.model_validate(m) for m in kept["messages"]),
                *model_messages(provider, conversation, int(kept["seen"])),
            ]
        self.seen = len(conversation.messages)
        self.tools = model_tools(conversation)
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


def finish(ctx: AisdkContext, result: object) -> Payload:
    """The raw provider body of the call whose message `run` returned."""
    call = next((c for c in reversed(ctx.llm.calls) if c.message is result), None)
    if call is None:
        raise TypeError(
            "run(ctx) must return a message from ctx.llm.generate(...), "
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
        {
            "seen": ctx.seen,
            "messages": [m.model_dump(mode="json") for m in ctx.context_messages],
        },
    )
    return copy.deepcopy(call.raw)
