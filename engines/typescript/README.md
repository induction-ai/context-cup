# TypeScript engine

The Python engine's lane in TypeScript: `run(ctx)` gets the provider's own
request body, calls the model with whatever client it likes, and returns the
provider's response. Start from
[`base_typescript`](../../drivers/base_typescript); the overview is
[docs/drivers.md](../../docs/drivers.md).

```ts
import type { TypeScriptContext } from "@context-cup/engine-typescript";
import OpenAI from "openai";

export async function run(ctx: TypeScriptContext) {
  return new OpenAI().responses.create(ctx.contextPayload as any);
}
```

## What comes in

`ctx` is a `TypeScriptContext` (`import type { TypeScriptContext } from
"@context-cup/engine-typescript"`).

| attribute             | type                     | example                                                                                                                             | lifetime                                                                                                                              |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.contextPayload`  | `Payload`                | `{ model: "gpt-5.5", instructions: "…", input: [...], tools: [...], reasoning: {...} }`                                             | **persists**: leave in it the request you sent; the course appends the model's reply and the tool results and hands it back next turn |
| `ctx.originalPayload` | `Payload`                | same shape, every message and result as it happened                                                                                 | read only; the course appends to it each turn and never edits it                                                                      |
| `ctx.state`           | any JSON                 | `{ summarised: 4 }`                                                                                                                 | **persists**: whatever it holds when `run` returns comes back next turn; `{}` on turn one                                             |
| `ctx.first`           | `boolean`                | `true`                                                                                                                              | read only; true on the trial's first turn                                                                                             |
| `ctx.provider`        | `ProviderInfo`           | `name: "openai"`, `api_key: "cc-proxy"`, `client.base_url: "http://127.0.0.1:18080/t/<trial>/openai/v1"`, `client.api: "responses"` | read only, fixed for the trial                                                                                                        |
| `ctx.target`          | `Target`                 | `model: "gpt-5.5"`, `reasoning_effort: "medium"`                                                                                    | read only, fixed for the trial; already applied in the first payload                                                                  |
| `ctx.config`          | `Record<string, any>`    | `{ max_bytes: 100000 }`                                                                                                             | read only; your `package.json` `contextCup.config`                                                                                    |
| `ctx.dirs`            | `Dirs`                   | `turn: "/logs/agent/turns/003_k3v9xq"`, `state: "/logs/agent/driver_state"`, `workspace: null`                                      | `turn` is new each turn; files in `state` survive the trial; `workspace` is the task's working directory on Toolathlon                |
| `ctx.turnId`          | `string`                 | `"003_k3v9xq"`                                                                                                                      | new each turn, also each retry                                                                                                        |
| `ctx.turn`            | `TurnInput`              | the whole `input.json` as written (snake_case), e.g. `ctx.turn.turn_index`, `ctx.turn.limits.max_steps`                             | read only                                                                                                                             |
| `ctx.view()`          | `() => Conversation`     | `system`, `messages` (role `user`/`assistant`/`tool`, `text`, `toolCalls`, `toolCallId`, `opaque`), `tools`                         | a fresh provider-neutral reading of `ctx.contextPayload` each call                                                                    |
| `ctx.write(conv)`     | `(Conversation) => void` | —                                                                                                                                   | puts a view's edits back into `ctx.contextPayload`, touching only what changed                                                        |

The view is the TypeScript twin of the Python engine's, from
`@context-cup/protocol` (`course/protocol/src/view.ts`), and reads every
payload the same way. Edit a message in place (`message.text = …`) or
through a spread copy (`{ ...message, text }`); either patches the native
item it came from. A message built from scratch is new material. Keep each
tool call with its result, since a provider rejects either half on its own.

## What you return

The provider's response for the call that is your turn, as JSON: what an SDK
call resolves to (`openai`, `@anthropic-ai/sdk`), or the parsed body of a
`fetch`. The engine writes it to `output.json` through `JSON.stringify`, so
`undefined` fields drop out. Anything that is not an object fails the turn.
Your auxiliary calls (summaries and the like) are not returned; the proxy
has already counted them.

## Packages and the bundle

A trial container has the runner's `node` but no package manager, so a
TypeScript driver is bundled on the host. List what the driver imports in
its own `package.json` `dependencies` like any workspace package, and
`pnpm install`. Before the first trial, `bin/suite` runs this engine's
`build.sh`, which bundles the engine's entry point, your `driver.ts`, and
every package they import into `bundle/turn.mjs` in your driver's directory
(gitignored), with a source map so a stack trace in `stderr.txt` points at
`driver.ts`. The runner uploads it with the package and `run.sh` runs it
with `$CC_NODE`. No `setup.sh` is needed, and a driver never installs
anything in the container.

The provider SDKs need no configuration there: the runner has pointed every
SDK at the proxy (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`,
`GOOGLE_GEMINI_BASE_URL`, placeholder keys).

To try a driver outside a trial, bundle it and hand it an `input.json` from
an earlier run:

```
CC_SELF_DIR=engines/typescript CC_DRIVER_DIR=drivers/<name> bash engines/typescript/build.sh
node --enable-source-maps drivers/<name>/bundle/turn.mjs --driver drivers/<name> \
  --input <turn>/input.json --output /tmp/out.json
```

## A worked example

Summarise older, large tool results once with a cheaper model, keeping the
three newest verbatim. The summaries persist in `contextPayload`, so each is
paid for once, and the header labels them in the accounting.

```ts
import type { TypeScriptContext } from "@context-cup/engine-typescript";
import OpenAI from "openai";

const client = new OpenAI();

export async function run(ctx: TypeScriptContext) {
  const conversation = ctx.view();
  const results = conversation.messages.filter(
    (m) => m.role === "tool" && m.text
  );
  for (const message of results.slice(0, -3)) {
    if (
      message.text!.length > 2_000 &&
      !message.text!.startsWith("[summary]")
    ) {
      const summary = await client.responses.create(
        {
          model: "gpt-5.4-mini",
          input: `Summarise this tool output for later reference:\n\n${message.text}`,
        },
        { headers: { "x-cc-purpose": "summarize" } }
      );
      message.text = `[summary] ${summary.output_text}`;
    }
  }
  ctx.write(conversation);
  return client.responses.create(ctx.contextPayload as any);
}
```

Tests: `bin/test --project engine-typescript` (and `--project protocol` for
the view).
