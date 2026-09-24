# AI SDK engine

The TypeScript engine's shape in the [AI SDK](https://ai-sdk.dev)'s terms,
as the LiteLLM engine is the Python engine's in LiteLLM's: the conversation
arrives as AI SDK `ModelMessage`s instead of native payloads, and `ctx.llm`
is an AI SDK handle already set up for the run. A driver edits
`ctx.contextMessages` if it wants to, and returns the `generateText` result
of the call that is its turn. One strategy serves OpenAI, Anthropic, and
Gemini. Start from [`base_aisdk`](../../drivers/base_aisdk); the overview is
[docs/drivers.md](../../docs/drivers.md).

```ts
import type { AisdkContext } from "@context-cup/engine-aisdk";

export async function run(ctx: AisdkContext) {
  return ctx.llm.generateText(); // the working conversation as it stands
}
```

## What comes in

`ctx` is an `AisdkContext`. Messages are the AI SDK's own `ModelMessage`
type, what `generateText({ messages })` takes.

| attribute                                          | type                       | example                                                                                                                                      | lifetime                                                                                                                                                              |
| -------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.contextMessages`                              | `ModelMessage[]`           | `[{ role: "user", … }, { role: "assistant", content: [{ type: "tool-call", … }] }, { role: "tool", content: [{ type: "tool-result", … }] }]` | **persists**: turn one gets the whole conversation; after that, last turn's list as you left it, plus what came in since (the model's reply, tool results, user text) |
| `ctx.instructions`                                 | `Instructions`             | the course's system prompt, `"You are a bank agent…"`                                                                                        | **persists** like `contextMessages`; the AI SDK takes the system prompt beside the messages, not among them                                                           |
| `ctx.originalMessages`, `ctx.originalInstructions` | `ModelMessage[]`, `string` | the whole record, same shape                                                                                                                 | read only; rebuilt from the course's record each turn                                                                                                                 |
| `ctx.tools`                                        | `ToolSet`                  | `{ get_balance: tool({ description, inputSchema }) }`, no `execute`                                                                          | the course's tools, each turn                                                                                                                                         |
| `ctx.llm`                                          | `LLM`                      | `ctx.llm.generateText()`                                                                                                                     | new each turn; see below                                                                                                                                              |
| `ctx.state`                                        | any JSON                   | `{ prunedThrough: 12 }`                                                                                                                      | **persists**, and is yours alone; `{}` on turn one                                                                                                                    |
| `ctx.first`                                        | `boolean`                  | `true`                                                                                                                                       | true on the trial's first turn                                                                                                                                        |
| `ctx.provider`                                     | `ProviderInfo`             | `name: "anthropic"`, `api_key: "cc-proxy"`, `client.base_url: "…/t/<trial>/anthropic/v1"`                                                    | fixed for the trial                                                                                                                                                   |
| `ctx.target`                                       | `Target`                   | `model: "claude-sonnet-4-6"`, `reasoning_effort: null`                                                                                       | fixed for the trial                                                                                                                                                   |
| `ctx.config`                                       | `Record<string, any>`      | `{ max_bytes: 100000 }`                                                                                                                      | your `package.json` `contextCup.config`                                                                                                                               |
| `ctx.dirs`                                         | `Dirs`                     | `turn: "/logs/agent/turns/003_k3v9xq"`, `state: "/logs/agent/driver_state"`                                                                  | files in `state` survive the trial; the engine keeps its own `aisdk_context/` there, one file per accepted turn                                                       |
| `ctx.contextPayload`, `ctx.originalPayload`        | `Payload`                  | the course's native request bodies                                                                                                           | informational; the messages above are built from them                                                                                                                 |
| `ctx.turn`                                         | `TurnInput`                | the whole `input.json`                                                                                                                       | read only                                                                                                                                                             |

`ctx.llm.generateText(options?)` is the AI SDK's `generateText` with the
run's connection filled in. Defaults: `instructions: ctx.instructions` and
`messages: ctx.contextMessages` (both left out when you pass a `prompt` or
`messages`), `tools: ctx.tools`, the target model, and, on the target, the
reasoning settings the course put in its payload (OpenAI's effort,
Anthropic's thinking budget and `max_tokens`, Gemini's thinking config).
Every option can be overridden. `model` is a name: a bare name is on the
run's provider, and `openai/…`, `anthropic/…`, `gemini/…` pick another,
still through the proxy. `purpose` labels the call in the accounting. Call it
as often as you like.

`ctx.llm.model(name?, { purpose })` is an AI SDK `LanguageModel` on the proxy,
for calls you make with the AI SDK directly (`generateObject`, `streamText`,
an agent loop of your own). Those are counted like any other; only
`ctx.llm.generateText` can make the turn's call.

## What you return

A result from `ctx.llm.generateText(...)`, the one that is your turn. The
engine emits the raw provider body of that exact call as the turn's
`response`. It must be a call on the run's provider; a result from anywhere
else, or anything that is not a result, fails the turn. What
`ctx.instructions` and `ctx.contextMessages` hold when `run` returns is kept
for the next turn.

## What the engine owns

The connection on every call: the AI SDK provider for the model (OpenAI over
the Responses API, the wire the course speaks), the proxy base URL for the
call's provider, the placeholder key, `store: false` on OpenAI, and the
`x-cc-purpose` header. It captures each call's raw body, persists the
working copy, and folds each turn's new input into it. Only a turn the
runner accepts carries forward: when an attempt is thrown away (an empty
reply, a failed turn), its retry starts from the last accepted turn's working
copy, as `ctx.state` does.

Reasoning is carried across turns where the AI SDK reads it back: OpenAI's
encrypted reasoning items and Anthropic's signed thinking blocks become
reasoning parts, and Gemini's thought signatures ride on their function
calls (without them Gemini 3 loses its reasoning between turns). What has
no AI SDK form, such as a hosted tool's call, is not carried; drivers that
need it work with the native payload on
[`engines/typescript`](../typescript).

Bundling works as on the TypeScript engine: `build.sh` bundles the driver and
the AI SDK on the host, and `run.sh` runs the bundle with `$CC_NODE`.

## A worked example

Summarise all but the three newest tool results with a cheaper model, once
each. The edits persist, so a result is summarised a single time, and
replacing only the output keeps every tool call paired with its result,
which providers require.

```ts
import type { AisdkContext } from "@context-cup/engine-aisdk";

const KEEP = 3;

export async function run(ctx: AisdkContext) {
  const results = ctx.contextMessages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .filter((part) => part.type === "tool-result");
  for (const part of results.slice(0, -KEEP)) {
    if (
      part.output.type !== "text" ||
      part.output.value.startsWith("[summary]")
    ) {
      continue;
    }
    const summary = await ctx.llm.generateText({
      model: "openai/gpt-5.4-mini",
      prompt: `Summarise:\n\n${part.output.value}`,
      tools: {},
      purpose: "summarize",
    });
    part.output = { type: "text", value: `[summary] ${summary.text}` };
  }
  return ctx.llm.generateText();
}
```

Tests: `bin/test --project engine-aisdk`.
