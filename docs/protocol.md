# Driver protocol

How the course talks to a driver during a trial. Everything here is a file on
disk or a command line, so a driver can be written in any language.

## Roles

```
harbor trial container
┌──────────────────────────────────────────────────────────────────┐
│ course runner (Python, course/runner)                            │
│   owns: both payloads, the environment's MCP tools, stop condition,│
│         usage and trajectory files harbor reads back             │
│                                                                  │
│   per turn ──► turns/NNN_xxxxxx/input.json                       │
│                exec <engine command> --input … --output …        │
│                turns/NNN_xxxxxx/output.json ──► append response  │
│                run environment tool calls, repeat                │
│                                                                  │
│ driver process (any engine, any language)                        │
│   owns: what to send the model, the model calls, private tools   │
└──────────────────────────────────────────────────────────────────┘
```

The course never calls a model. The driver never calls an environment tool.

## Driver package

A driver is a pnpm workspace package with up to three executables. An engine
is a driver that other drivers build on; the two have the same shape and the
tooling treats them alike. The pattern is Dev Container Features: a manifest,
an install script, and a dependency order the tooling honours.

```
drivers/base_truncate/
  package.json
  setup.sh       optional  runs once per trial, after the parent's setup.sh
  run.sh         optional  runs once per turn: run.sh <input.json> <output.json>
  teardown.sh    optional  runs once per trial, before the parent's teardown.sh
  driver.py      what the inherited run.sh expects: for the python engine,
                 `def run(ctx)` that calls the model and returns its response

engines/python/
  package.json   { "name": "@context-cup/engine-python", … }
  setup.sh       installs litellm, pydantic and the engine package
  run.sh         exec python3 -m context_cup_engine --driver "$CC_DRIVER_DIR" \
                   --input "$1" --output "$2"
```

`package.json` carries the protocol fields under `contextCup`:

```json
{
  "private": true,
  "name": "@context-cup-drivers/base_truncate",
  "version": "0.1.0",
  "description": "Clip any tool result over max_bytes.",
  "contextCup": {
    "kind": "driver",
    "extends": "@context-cup/engine-python",
    "providers": ["openai", "anthropic", "gemini"],
    "config": { "max_bytes": 100000 }
  }
}
```

- `kind` is `driver` or `engine`. Suite files name drivers by the part of
  the package name after `@context-cup-drivers/`. Engines and course packages
  stay under `@context-cup/`.
- `extends` is the package name of the parent, resolved through the pnpm
  workspace (`course/*`, `engines/*`, `drivers/*`). Absent for a root
  package. Chains may be any depth: an engine can extend an engine.
- `providers` lists the providers the package can drive, from `openai`,
  `anthropic`, `gemini`. A driver built on litellm can list all three; one
  that speaks a single SDK lists one. When absent, the package
  supports whatever its parent supports, and a root package with no list
  supports every provider. The suite skips a driver × target cell whose
  provider is not supported and says so, rather than running it to fail.
- `config` is free-form and is passed to the driver by whichever engine runs
  it.
- Ordinary `dependencies` and `scripts` are for the host side only:
  `pnpm install` never runs inside a trial container, so anything the driver
  needs at run time is installed by `setup.sh`.

**Resolution, root to leaf.** Given the chain `[engine-python, base_truncate]`:

| phase    | what runs                                                   |
| -------- | ----------------------------------------------------------- |
| setup    | every `setup.sh` in the chain, root first                   |
| turn     | the `run.sh` nearest the leaf; parents' run.sh are shadowed |
| teardown | every `teardown.sh` in the chain, leaf first                |

Scripts run inside the trial container with the working directory set to
their own package directory, and see:

| var             | meaning                                                         |
| --------------- | --------------------------------------------------------------- |
| `CC_DRIVER_DIR` | the leaf package directory                                      |
| `CC_SELF_DIR`   | the directory of the script being run                           |
| `CC_CHAIN`      | every package directory root to leaf, colon separated           |
| `CC_STATE_DIR`  | the driver-private directory that survives across turns         |
| `CC_TRIAL_ID`   | the trial id                                                    |
| `CC_PYTHON`     | the runner's own Python 3.12, a uv venv; engines make their own |
| `CC_TURN_DIR`   | run.sh only: the current turn directory                         |

Python in a trial container is always a uv-managed 3.12. The runner uploads a
pinned `uv`, puts it on `PATH` for every script with `UV_CACHE_DIR` and
`UV_PYTHON_INSTALL_DIR` shared, and never uses the task image's interpreter.
An engine's `setup.sh` does the same: `uv venv --python 3.12` into its own
directory, then `uv pip install` into that venv.

A `setup.sh` that fails ends the trial before the first turn. A `run.sh`
that exits non-zero fails the turn (see retries below).

## Turn directory

Under the trial's agent log directory, which harbor copies out of the
container:

```
turns/
  001_k3v9xq/
    input.json
    output.json
    stdout.txt
    stderr.txt
  002_pz7m1a/
    …
```

Turn ids are a zero-padded 3-digit index starting at `001` followed by `_`
and six lowercase base36 characters, so a directory listing is in order and
two runs of the same trial never collide.

## Payloads

The course speaks each provider's own request and response format and never
normalises them. What a driver sees is exactly what the model sees.

| provider    | request body (`*_payload`)                                                  | response (`response`)       |
| ----------- | --------------------------------------------------------------------------- | --------------------------- |
| `openai`    | Responses API: `model`, `instructions`, `input` items, `tools`, `reasoning` | the Responses object        |
| `anthropic` | Messages API: `model`, `system`, `messages` with content blocks, `tools`    | the Message object          |
| `gemini`    | `generateContent`: `systemInstruction`, `contents` with parts, `tools`      | the GenerateContentResponse |

A payload is the whole HTTP request body except credentials, so a driver can
reshape the tools or the system prompt as well as the conversation. The
course builds the first one (system prompt, tools, the task's opening user
turn) and from then on appends in native form: the response's output
(reasoning items, thought signatures and all) and the tool results for the
calls it made.

## input.json

```json
{
  "protocol": 2,
  "trial_id": "tau3-banking_knowledge-task-047__C6gys3m",
  "turn_id": "003_k3v9xq",
  "turn_index": 3,
  "first": false,
  "provider": {
    "name": "openai",
    "api_key": "sk-…",
    "client": { "base_url": "https://api.openai.com/v1", "api": "responses" }
  },
  "target": { "model": "gpt-5.5", "reasoning_effort": "medium" },
  "context_payload": {
    "model": "gpt-5.5",
    "instructions": "…",
    "input": [
      { "role": "user", "content": "…" },
      { "type": "reasoning", "id": "rs_…", "encrypted_content": "…" },
      { "type": "function_call", "call_id": "call_1", "name": "get_balance", "arguments": "{…}" },
      { "type": "function_call_output", "call_id": "call_1", "output": "…" }
    ],
    "tools": [ { "type": "function", "name": "get_balance", "parameters": { … } } ],
    "reasoning": { "effort": "medium" },
    "store": false,
    "include": ["reasoning.encrypted_content"]
  },
  "original_payload": { …same shape, never modified… },
  "state": {},
  "limits": { "max_steps": 200 },
  "dirs": { "turn": "…", "state": "…", "workspace": "…" }
}
```

- `first` is true on the first turn of a trial, the moment to inject
  anything that should be there from the start.
- `provider` is everything needed to call the model: the family name, the
  key, and the client settings (`base_url` and which API: `responses`,
  `messages`, or `generate_content`). The key is real while the turn runs;
  once the turn is over the runner rewrites the persisted `input.json` with
  it redacted, so trial artifacts never carry credentials.
- `context_payload` is the driver's working copy. It starts equal to the
  original and carries the driver's edits from turn to turn: what the driver
  sent last turn, plus the response and tool results the course appended.
- `original_payload` is the immutable record: every message, every tool
  result, every response, in the order they happened. Compress from it,
  compare against it, never expect the course to change it.
- `state` is any JSON the driver returned last turn, echoed back. `dirs.state`
  is a directory for anything too large for that.
- `target.reasoning_effort` is already applied in the initial payload
  (`reasoning` for OpenAI, `thinking` for Anthropic, `thinkingConfig` for
  Gemini); it is repeated here for reference.

## output.json

```json
{
  "protocol": 2,
  "turn_id": "003_k3v9xq",
  "response": { …the provider's response object, verbatim… },
  "context_payload": { …the request the driver sent, if it differs from the input… },
  "state": { "summaries": 2 },
  "calls": [ … ],
  "driver": { "name": "base_truncate", "engine": "python", "version": "0.1.0" }
}
```

- `response` is what the provider returned for the turn, untouched. The
  course reads its text and tool calls in native form and appends its output
  to both payloads.
- `context_payload`, when present, is the request the driver actually sent
  this turn. The course appends the response and tool results to it and hands
  it back as next turn's `context_payload`. When absent, the input's
  `context_payload` is taken as what was sent.
- `state` replaces last turn's state wholesale; absent means unchanged.
- `calls` lists every model call the driver made this turn, in order,
  including calls that were not the main turn (summaries, reranking). The
  engine records them at the HTTP layer; the driver reports nothing. Each
  carries `provider`, `host`, `model`, `wire`, `purpose`, `usage`
  (`input` including cached, `cached_input`, `cache_write_input`, `output`,
  `reasoning_output`), `duration_ms`, `service_tier`, `status`.
- Anything else a driver wants remembered, such as private tool round trips
  it answered itself, belongs in `state`.

A non-zero exit, a missing `output.json`, or a `response` with neither text
nor tool calls fails the turn. The runner retries a failed turn up to
`CC_TURN_RETRIES` times (default 2) with a fresh turn id, then ends the
trial with an error that harbor records.

The driver may call any model for auxiliary work: subagents, summaries,
reranking, anything. Only `response` is the turn's answer; the rest is
accounted for through `calls`. The Python engine records calls made from the
driver's own process, with any client library. Work done in a subprocess is
invisible to it and therefore does not count; a driver that needs that
should keep the calls in-process. A trial whose main-turn calls went to a model other than the
target is flagged in the results, not blocked.

## Environment variables the runner sets for the driver process

| var                  | meaning                                      |
| -------------------- | -------------------------------------------- |
| `OPENAI_API_KEY` etc | provider keys forwarded from the host `.env` |
| `CC_TRIAL_ID`        | same as `trial_id` in the payload            |
| `CC_TURN_DIR`        | same as `dirs.turn`                          |

Provider base URLs are the real provider endpoints. Nothing sits between the
driver and the provider.

## Files the runner writes per trial

Besides `turns/`, in the agent log directory:

- `usage.json`: `{ "calls": [ …every call from every turn, with turn_id… ],
"totals": { input, cached_input, cache_write_input, output, reasoning_output } }`.
- `trajectory.json`: harbor ATIF, built from `original_payload`.
- `summary.json`: `{ stop_reason, turns, env_tool_calls, errors, driver, target, started_at, finished_at }`.

The suite ingests these plus harbor's `result.json` and the verifier's
`reward.txt`.

## How the suite launches the runner

`bin/suite` shells out to `harbor run` once per (task, driver, target) job.
The harbor agent classes live in `course/runner` and are selected with
`--agent context_cup_runner.tau3:Tau3Agent` or
`--agent context_cup_runner.toolathlon:ToolathlonAgent`, with
`PYTHONPATH=course/runner/src` so harbor's process can import them.

The agent class runs on the host inside harbor's process. Its `setup` uploads
the in-container loop and every package directory in `CC_HOST_DRIVER_CHAIN` into
the trial container and runs each `setup.sh` root to leaf. Its `run` execs the loop
inside the container and, when it finishes, reads `usage.json` and
`summary.json` back into harbor's `AgentContext`.

Settings reach the agent class through `--agent-env`:

| var                    | value                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CC_HOST_DRIVER_CHAIN` | host paths of every package in the chain, root to leaf, colon separated (the suite resolves `extends`). harbor layers these values over every exec the agent runs, so the container-side list travels under `CC_DRIVER_CHAIN` instead |
| `CC_TARGET_JSON`       | the `target` object from input.json, as JSON                                                                                                                                                                                          |
| `CC_TURN_RETRIES`      | optional, default 2                                                                                                                                                                                                                   |
| `CC_MAX_STEPS`         | optional cap on turns, default per benchmark                                                                                                                                                                                          |

Provider keys are forwarded the same way, and the tau3 user simulator and
verifier keep the job-level `OPENAI_API_KEY`.

## Naming

Drivers shipped with the course are prefixed `base_`: `base_passthrough`
sends the context payload unchanged, `base_truncate` clips oversized tool results.
Contestants pick any other prefix.
