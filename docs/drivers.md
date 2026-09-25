# Writing a driver

A driver is a context-management strategy: each turn it decides what the
model sees, makes the call, and hands back the model's answer. The course
runs the environment (tools, simulated user, verifier) and scores the result
on accuracy and cost. This page is for driver authors; the wire-level
contract is [protocol.md](protocol.md).

The bar to beat is a fixed baseline per benchmark at the reference target:
match or beat its score while a full run costs less, and the cheapest driver
that does leads. The full rule is under "Winning" in the
[README](../README.md#winning).

## Pick a lane

| lane                                          | `run(ctx)` receives                                                                    | `run(ctx)` returns                                           | copy this                         | pick it when                                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`engines/python`](../engines/python)         | the provider's native request body, plus a provider-neutral view of it                 | the provider's response: the SDK object or its JSON          | `base_passthrough`, `base_python` | you want exact control: reasoning items, cache-control blocks, and thought signatures are all in front of you. Bring any SDK.                          |
| [`engines/pydantic`](../engines/pydantic)     | read-only turn facts                                                                   | Pydantic AI capabilities (a list), or a whole `Agent`        | `base_pydantic`                   | your strategy is a Pydantic AI (Harness) capability: compaction, tool-output limits, your own history processor.                                       |
| [`engines/litellm`](../engines/litellm)       | the conversation as litellm chat messages, and `ctx.llm`, a litellm handle for the run | a litellm response from `ctx.llm.completion(...)`            | `base_litellm`                    | you want one strategy for OpenAI, Anthropic, and Gemini over chat messages, and can live without OpenAI reasoning items and Anthropic thinking blocks. |
| [`engines/typescript`](../engines/typescript) | the Python engine's `ctx` in TypeScript: the native request body and the same view     | the provider's response as JSON                              | `base_typescript`                 | you want the Python lane's exact control, in TypeScript, with npm SDKs.                                                                                |
| [`engines/aisdk`](../engines/aisdk)           | the conversation as AI SDK messages, and `ctx.llm`, an AI SDK handle for the run       | a result from `ctx.llm.generateText(...)`                    | `base_aisdk`                      | you want one strategy for OpenAI, Anthropic, and Gemini over the AI SDK's messages, with each provider's reasoning carried for you.                    |
| `kind: "agent"`, a script                     | harbor's instruction and the task's MCP servers, in `agent.sh`'s environment           | nothing: the agent works the task and the verifier scores it | `base_agent`                      | you want your own whole agent, written from scratch in any language: its own loop, its own context. Compared on score and cost.                        |
| `kind: "agent"`, harbor's own                 | nothing: harbor runs a whole agent against the task                                    | nothing: the agent works the task and the verifier scores it | `base_codex`                      | you are entering an existing agent (Codex, Claude Code) as it is. Compared on score and cost only.                                                     |

In the engine lanes the course owns the loop: every turn it writes
`input.json`, runs your `run(ctx)` once, reads the model's response, runs any
tools it asked for, appends the results, and calls you again. A turn ends
when the model asks for an environment tool or answers in text. Tools a
driver owns itself (a memory, a summariser) run inside your turn and never
reach the course. Toolathlon's environment cuts tool results over 100,000
characters, as upstream Toolathlon does, and offers the four
`local-*_overlong_tooloutput` tools that search and page the saved text;
they arrive in the task's tool list like any other environment tool.
tau3's environment cuts them at the same length, with a note, and offers no
such tools; the whole text is saved under the agent log directory's
`clipped_tool_outputs/`.

## Start a driver

Copy the base driver of your lane to `drivers/<your_name>/` and edit.

`package.json` holds everything the course reads about a driver:

```json
{
  "private": true,
  "name": "@context-cup-drivers/keep_recent",
  "version": "0.1.0",
  "description": "Blanks all but the three most recent tool results.",
  "contextCup": {
    "kind": "driver",
    "extends": "@context-cup/engine-python",
    "providers": ["openai"],
    "config": { "keep": 3 }
  }
}
```

- `name`: scoped `@context-cup-drivers/`; the part after the slash is what
  `bin/suite --driver` takes. The `base_` prefix is reserved for the course's
  own drivers.
- `extends`: the engine, which decides what `ctx` is and what `run` returns.
- `providers`: the providers your driver can drive. `bin/suite` refuses a
  target on any other provider. Omitted, it inherits the engine's list.
- `config`: free-form; it arrives as `ctx.config`. Keep tunables here so a
  variant is a manifest edit, not a code change.

`driver.py` defines `run(ctx)` (`driver.ts` exports it, on the TypeScript
lanes). It may import sibling files in its own directory, and
`context_cup_protocol` (`@context-cup/protocol` in TypeScript, the protocol
library), and nothing else from the course.

`setup.sh` (optional) installs what your driver needs into the engine's
venv, once per trial container. The Python engine installs no provider SDK,
so its drivers always have one:

```bash
#!/usr/bin/env bash
set -euo pipefail
uv pip install --quiet --python "${CC_CHAIN%%:*}/.venv/bin/python" openai
```

`${CC_CHAIN%%:*}` is the first package of your chain, the engine, whose venv
runs your code. `uv` is on `PATH` in every setup script; the container's own
Python is never used.

A TypeScript driver needs no `setup.sh`: list its npm packages in
`package.json` `dependencies`, `pnpm install`, and the engine's `build.sh`
bundles them with `driver.ts` on the host before every run (see
[engines/typescript](../engines/typescript)).

## Models, keys, and accounting

- **Every call goes through the trial's proxy.** It runs inside your
  container on `127.0.0.1:18080`. Your process has placeholder keys
  (`cc-proxy`) and base URLs pointing at the proxy (`OPENAI_BASE_URL`,
  `ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, and
  `ctx.provider.client.base_url`). SDKs read those without configuration. A
  call that goes around the proxy has no key and fails with 401.
- **Your code runs unprivileged.** `setup.sh` runs as root, so install
  whatever you need there. Each turn's `run.sh` (and `teardown.sh`) runs as
  the user `ccdriver`, which can read everything setup installed and write
  `ctx.dirs.turn`, `ctx.dirs.state`, and its own `HOME`, but cannot read the
  proxy's keys. Anything a turn must write elsewhere, set up with the right
  permissions in `setup.sh`.
- **Every call is counted.** The proxy records each call's model, tokens,
  and timing; the suite prices it. Summaries, reranking, subagents: all of it
  is in your cost. Label auxiliary calls with the header
  `x-cc-purpose: <label>` (`ctx.llm.completion(purpose=...)` on litellm,
  `ctx.llm.generateText({ purpose })` on the AI SDK);
  unlabelled calls count as `turn`.
- **You pick your models, from the target's provider.** `target` is the
  run's model and the default, not a requirement: call a cheaper model from
  the same provider for summaries, but not another provider's. Name `cc-model`
  (or omit the model) to get the run's target; a model you name is forwarded
  unchanged and priced under that name.
- **No other external calls.** Model calls go only to the base URL you are
  given. Beyond that, a turn reaches nothing outside the container but the
  task's own tools: no web search, outside APIs, or downloads. Install your
  dependencies in `setup.sh`. The full rules are under "Rules" in the
  [README](../README.md#rules).

## What persists between turns

Each turn is a fresh process, so anything you keep must be written down:

- `ctx.state`: any JSON; whatever it holds at the end of `run` comes back
  next turn. (The Pydantic engine uses it for its own bookkeeping.)
- `ctx.dirs.state`: a directory that survives the whole trial, for anything
  too big for `state`: indexes, summaries, spilled outputs.
- The working conversation: `ctx.context_payload` on the Python engine,
  `ctx.context_messages` on litellm, `ctx.contextPayload` on TypeScript,
  `ctx.contextMessages` (and `ctx.instructions`) on the AI SDK. Your edits carry forward; the course
  appends the model's reply and the tool results to what you left.

## Run it

```
bin/suite smoke_tau --driver keep_recent --target gpt-5.5@medium
bin/suite smoke_tau --driver keep_recent --target gpt-5.5@medium --count 5
bin/suite toolathlon_local --driver keep_recent --target gpt-5.5@medium
bin/suite smoke_tau                                    # choose driver and target from a list
```

`--count` is attempts per task; single trials swing widely, so compare
drivers at `--count 5` or more. The last lines print the results table and a
link to the results site (`pnpm site:dev`), where every trial has its own
page with its model calls.

## When a turn fails

The run ends with a non-zero exit and a line pointing at the results page,
where each errored trial shows its error. Each turn leaves a directory under
the trial's agent logs,
`.temp/suites/<suite>/<job>/harbor/<job>/<trial>/agent/turns/NNN_xxxxxx/`:

| file          | what to read in it                                       |
| ------------- | -------------------------------------------------------- |
| `input.json`  | exactly what your `run(ctx)` was given                   |
| `output.json` | what it returned: `response`, `context_payload`, `state` |
| `stderr.txt`  | your traceback, and any provider error message           |
| `stdout.txt`  | anything your driver printed                             |

A failed turn is retried three times with a fresh turn id; four failures end
the trial with the last error, which also shows on the trial's page, and the
trial is left unscored. A reply with neither text nor tool calls is
discarded as well as retried: its calls show on the trial page marked
"discarded" and stay out of the trial's tokens and cost. Any other failed
attempt still counts toward cost. Beside
`turns/`, `setup_<package>.txt` holds each `setup.sh`'s output, and
`runner.txt` the loop's own log, `calls.jsonl` every model call the proxy
recorded, and `proxy.txt` the proxy's own output. Set `CC_SAVE_BODIES=1` to
keep every request and response the proxy saw under `bodies/` there too.
