# AI SDK for Python engine

The LiteLLM engine's shape in the
[AI SDK for Python](https://github.com/vercel/ai-sdk-python)'s terms, as the
AI SDK engine is the TypeScript engine's: the conversation arrives as AI SDK
`Message`s instead of native payloads, and `ctx.llm` is an AI SDK handle
already set up for the run. A driver edits `ctx.context_messages` if it
wants to, and returns the message of the call that is its turn. One strategy
serves OpenAI and Anthropic (the SDK has no Gemini provider). Start from
[`base_aisdk_python`](../../drivers/base_aisdk_python); the overview is
[docs/drivers.md](../../docs/drivers.md).

```python
def run(ctx):
    return ctx.llm.generate()  # the working conversation as it stands
```

## What comes in

`ctx` is an `AisdkContext` (`from context_cup_aisdk import AisdkContext`).
Messages are the SDK's own `Message` type, what `ai.generate` and
`ai.stream` take: a role and a list of parts (`TextPart`, `ToolCallPart`,
`ToolResultPart`, `ReasoningPart`), built with `ai.user_message`,
`ai.assistant_message`, `ai.tool_message`, and the part helpers.

| attribute                                     | type            | example                                                                                                                 | lifetime                                                                                                                                                              |
| --------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.context_messages`                        | `list[Message]` | `[system_message("Be brief."), user_message("…"), assistant_message(ToolCallPart(…)), tool_message(ToolResultPart(…))]` | **persists**: turn one gets the whole conversation; after that, last turn's list as you left it, plus what came in since (the model's reply, tool results, user text) |
| `ctx.original_messages`                       | `list[Message]` | the whole record, same shape                                                                                            | read only; rebuilt from the course's record each turn                                                                                                                 |
| `ctx.tools`                                   | `list[ai.Tool]` | `[Tool(kind="function", name="get_balance", spec=ToolSpec(…))]`, nothing to run them                                    | the course's tools in SDK form, each turn                                                                                                                             |
| `ctx.llm`                                     | `LLM`           | `ctx.llm.generate()`                                                                                                    | new each turn; see below                                                                                                                                              |
| `ctx.state`                                   | any JSON        | `{"summarised_through": 12}`                                                                                            | **persists**, and is yours alone; `{}` on turn one                                                                                                                    |
| `ctx.first`                                   | `bool`          | `True`                                                                                                                  | true on the trial's first turn                                                                                                                                        |
| `ctx.provider`                                | `ProviderInfo`  | `name="anthropic"`, `api_key="cc-proxy"`, `client.base_url="…/t/<trial>/anthropic/v1"`                                  | fixed for the trial                                                                                                                                                   |
| `ctx.target`                                  | `Target`        | `model="claude-sonnet-4-6"`, `reasoning_effort=None`                                                                    | fixed for the trial                                                                                                                                                   |
| `ctx.config`                                  | `dict`          | `{"max_bytes": 100000}`                                                                                                 | your manifest's `config` (`[tool.context-cup.config]`)                                                                                                                |
| `ctx.dirs`                                    | `Dirs`          | `turn="/logs/agent/turns/003_k3v9xq"`, `state="/logs/agent/driver_state"`                                               | files in `state` survive the trial; the engine keeps its own `aisdk_context/` there, one file per accepted turn                                                       |
| `ctx.context_payload`, `ctx.original_payload` | `dict`          | the course's native request bodies                                                                                      | informational; the messages above are built from them                                                                                                                 |
| `ctx.turn`                                    | `TurnInput`     | the whole `input.json`                                                                                                  | read only                                                                                                                                                             |

`ctx.llm.generate(messages=None, *, model=None, tools=None, params=None,
purpose="turn")` is the SDK's `generate` with the run's connection filled
in. Defaults: `messages=ctx.context_messages`, `tools=ctx.tools` (pass `[]`
for none), the target model, and, on the target, the reasoning settings the
course put in its payload (OpenAI's effort, summary, and encrypted reasoning;
Anthropic's thinking budget and `max_tokens`). `params`, an
`ai.InferenceRequestParams`, replaces those settings; `store` stays off on
OpenAI either way. `model` is a name: a bare name is on the run's provider,
and `openai/…` or `anthropic/…` picks the other, still through the proxy.
`purpose` labels the call in the accounting. Call it as often as you like.
It returns the SDK's `Message`; `message.parts` holds its text, reasoning,
and tool calls.

The SDK's parts are immutable. To edit one, put a copy in its place:
`message.parts[i] = part.model_copy(update={"result": "…"})`.

## What you return

A message from `ctx.llm.generate(...)`, the one that is your turn. The
engine emits the raw provider body of that exact call as the turn's
`response`. It must be a call on the run's provider; a message from anywhere
else, or anything that is not a message, fails the turn. What
`ctx.context_messages` holds when `run` returns is kept for the next turn.

## What the engine owns

The connection on every call: the SDK provider for the model (OpenAI over
the Responses API, the wire the course speaks), the proxy base URL for the
call's provider, the placeholder key, `store: false` on OpenAI, and the
`x-cc-purpose` header. It captures each call's raw body, persists
`ctx.context_messages`, and folds each turn's new input into it. Only a turn
the runner accepts carries forward: when an attempt is thrown away (an empty
reply, a failed turn), its retry starts from the last accepted turn's list,
as `ctx.state` does.

The SDK only streams. The engine keeps the stream each call received and
rebuilds the provider's response from it: OpenAI's final event carries the
whole response, and Anthropic's SDK accumulates its events into one.

Reasoning is carried across turns where the SDK reads it back: an OpenAI
reasoning item travels on a reasoning part as the item itself, which the SDK
replays verbatim (encrypted content included), and an Anthropic thinking
block becomes a reasoning part with its signature. What has no SDK form
(a redacted thinking block, a hosted tool's call) is not carried; drivers
that need it work with the native payload on
[`engines/python`](../python).

## A worked example

Summarise all but the three newest tool results with a cheaper model, once
each. The edits persist, so a result is summarised a single time, and
replacing only the result keeps every tool call paired with its result,
which providers require.

```python
import ai
from ai.types.messages import ToolResultPart

KEEP = 3


def run(ctx):
    results = [
        (message, i)
        for message in ctx.context_messages
        if message.role == "tool"
        for i, part in enumerate(message.parts)
        if isinstance(part, ToolResultPart)
    ]
    for message, i in results[:-KEEP]:
        part = message.parts[i]
        if not isinstance(part.result, str) or part.result.startswith("[summary]"):
            continue
        summary = ctx.llm.generate(
            [ai.user_message(f"Summarise:\n\n{part.result}")],
            model="openai/gpt-5.4-mini",
            tools=[],
            purpose="summarize",
        )
        message.parts[i] = part.model_copy(
            update={"result": "[summary] " + summary.text}
        )
    return ctx.llm.generate()
```

Tests: `uv run pytest engines/aisdk_python`.
