# Driver protocol

Writing a driver? Start with [drivers.md](drivers.md): the lanes, what `ctx`
holds, and how to run and debug one. This page is the wire-level contract
underneath.

How the course talks to a driver during a trial. Everything here is a file on
disk or a command line, so a driver can be written in any language.

The reference implementation of the models below, the provider adapters,
the provider-neutral view, and the turn mechanics every engine shares
(`run_engine`) is the Python library `course/protocol`
(`context_cup_protocol`). The runner and the engines both import it; engines
and drivers may import it and nothing else from `course/`.

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
an install script, and a dependency order the tooling honours. An engine
defines the `ctx` its drivers' `run` receives: the Python engine hands over
the payloads with a provider-neutral view of them; the Pydantic engine takes
back Pydantic AI capabilities and runs the agent itself; the LiteLLM engine
hands over the conversation as litellm chat messages with a litellm handle
for the call. [drivers.md](drivers.md) and each engine's README have the
details.

```
drivers/base_truncate/
  package.json
  setup.sh       optional  runs once per trial, after the parent's setup.sh
  run.sh         optional  runs once per turn: run.sh <input.json> <output.json>
  teardown.sh    optional  runs once per trial, before the parent's teardown.sh
  driver.py      what the inherited run.sh expects: for the python engine,
                 `def run(ctx)` that calls the model with any client and
                 returns the provider's response

engines/python/
  package.json   { "name": "@context-cup/engine-python", … }
  setup.sh       a venv with the protocol library and the engine; no SDKs
  run.sh         exec .venv/bin/python -m context_cup_engine --driver "$CC_DRIVER_DIR" \
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

- `kind` is `driver` or `engine`. `bin/suite --driver` names a driver by the
  part of the package name after `@context-cup-drivers/`. Engines and course packages
  stay under `@context-cup/`.
- `extends` is the package name of the parent, resolved through the pnpm
  workspace (`course/*`, `engines/*`, `drivers/*`). Absent for a root
  package. Chains may be any depth: an engine can extend an engine.
- `providers` lists the providers the package can drive, from `openai`,
  `anthropic`, `gemini`. A driver with a client for each can list all three;
  one built on a single SDK lists one. When absent, the package supports
  whatever its parent supports, and a root package with no list supports
  every provider. `bin/suite` refuses a target whose provider the driver
  does not list.
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
their own package directory. `setup.sh` runs as root, so it can install
what it needs. `run.sh` and `teardown.sh` run as `ccdriver`, an
unprivileged user the runner creates in every container, with `HOME` set to
its own directory: they can read everything setup left behind and write the
turn and state directories, and nothing else of root's (see Accounting).
Scripts see:

| var               | meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `CC_DRIVER_DIR`   | the leaf package directory                                                     |
| `CC_SELF_DIR`     | the directory of the script being run                                          |
| `CC_CHAIN`        | every package directory root to leaf, colon separated                          |
| `CC_STATE_DIR`    | the driver-private directory that survives across turns                        |
| `CC_TRIAL_ID`     | the trial id                                                                   |
| `CC_PYTHON`       | setup.sh only: the runner's own Python 3.12, a uv venv; engines make their own |
| `CC_PROTOCOL_DIR` | setup.sh only: the uploaded protocol library to install                        |
| `CC_TURN_DIR`     | run.sh only: the current turn directory                                        |

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
    "api_key": "cc-proxy",
    "client": {
      "base_url": "http://127.0.0.1:18080/t/<trial_id>/openai/v1",
      "api": "responses"
    }
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
  client settings (`base_url` and which API: `responses`, `messages`, or
  `generate_content`), and a placeholder key. `base_url` points at the
  trial's proxy, which holds the real keys and forwards to the provider; see
  Accounting. The same URLs are in the environment as `OPENAI_BASE_URL`,
  `ANTHROPIC_BASE_URL`, and `GOOGLE_GEMINI_BASE_URL`, with the placeholder in
  the matching `*_API_KEY` variables, so any SDK a driver uses lands on the
  proxy without configuration.
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
- Anything else a driver wants remembered, such as private tool round trips
  it answered itself, belongs in `state`.

A non-zero exit, a missing `output.json`, a missing `response`, or a reply
with neither text nor tool calls fails the turn. The runner retries a failed turn up to
`CC_TURN_RETRIES` times (default 3) with a fresh turn id, then ends the
trial with an error that harbor records: the trial is unscored, not scored
zero. Failed attempts are not turns. An empty reply is also discarded: its
calls stay in the proxy's call log and in `model_call` (flagged
`discarded`) but are left out of the trial's tokens and cost, since a
blank response is a provider hiccup, not the driver's spend. Other failed
attempts count toward cost.

`target` is the model the course builds the initial payload for and labels
the run with. A driver may call whatever models it likes, for the turn's
main call or for subagents, summaries, and reranking, and every call is
recorded and priced under the model it actually named. Name `cc-model`, or
omit the model, to get the run's target; the proxy fills it in. A model a
driver names itself is forwarded unchanged and priced under that name. Only
`response` is the turn's answer; every call is accounted for by the
trial's proxy (see Accounting), whichever process or language makes it.

## Accounting

Every model call goes through the course proxy (`course/proxy`), and every
trial has its own: the runner uploads it, bundled into one file with a
`node` binary, and starts it inside the trial container before the driver
does anything, on `127.0.0.1:18080`. A driver gets a placeholder key and
base URLs of the form `http://127.0.0.1:18080/t/<trial_id>/<provider>/…`,
and the proxy injects the real key and forwards to the provider. A call that
bypasses the proxy has no credential and fails with 401.

The proxy is the only process in the container with the provider keys. It
runs as root; the keys reach it through a root-only file it deletes as it
starts, never through the environment of the loop or of any script. Driver
scripts run as `ccdriver`, which cannot read a root process's
`/proc/<pid>/environ`; the runner proves this in every container before the
first turn and records the result in `isolation.txt` in the agent log
directory, failing the trial if it does not hold. Agent drivers (below) are
the exception: harbor runs them as root, so they could read the keys.

The proxy writes one line per call to `calls.jsonl` in the trial's agent log
directory (`/logs/agent`, which harbor copies to `<trial>/agent/`):
trial, turn, sequence, purpose, provider, host, model, wire, usage (input
including cached, cached input, cache writes, output, reasoning output),
duration, status, and service tier. The runner tells the proxy which turn is
current before each attempt, so calls are attributed to turns; an agent
driver's calls carry no turn. A driver labels an auxiliary call by sending
the header `x-cc-purpose` with it (any SDK can add a header), and anything
unlabelled counts as `turn`. The suite reads each trial's own
`calls.jsonl`, prices every call on the host, and stores it as a
`model_call` row: every call through a trial's proxy is that trial's cost.
With `CC_SAVE_BODIES=1` the proxy also keeps every request and response
body under `bodies/` beside it.

## Environment variables the runner sets for the driver process

| var                                                                       | meaning                                            |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `OPENAI_BASE_URL`                                                         | the proxy's OpenAI prefix, ending in `/v1`         |
| `ANTHROPIC_BASE_URL`                                                      | the proxy's Anthropic prefix (the SDK adds `/v1`)  |
| `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_BASE_URL`                           | the proxy's Gemini prefix (the SDK adds `/v1beta`) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` | the placeholder `cc-proxy`                         |
| `CC_TRIAL_ID`                                                             | same as `trial_id` in the payload                  |
| `CC_TURN_DIR`                                                             | same as `dirs.turn`                                |

The process also inherits `run.sh`'s script variables above (`CC_DRIVER_DIR`,
`CC_SELF_DIR`, `CC_CHAIN`, `CC_STATE_DIR`).

Every provider endpoint a driver sees is the trial's proxy; no real key is
anywhere a driver can read.

## Files the runner writes per trial

Besides `turns/`, in the agent log directory:

- `trajectory.json`: harbor ATIF, built from `original_payload`.
- `summary.json`: `{ stop_reason, turns, env_tool_calls, errors, driver, target, started_at, finished_at }`.

- `calls.jsonl`: the proxy's call log (see Accounting); `proxy.txt` is its
  output.
- `isolation.txt`: the check that `ccdriver` cannot read the proxy's keys.

Usage is only in the call log. The suite ingests these, harbor's
`result.json`, and the verifier's `reward.txt`.

## How the suite launches the runner

`bin/suite` shells out to `harbor run` once per (task, driver, target) job.
The harbor agent classes live in `course/runner` and are selected with
`--agent context_cup_runner.tau3:Tau3Agent` or
`--agent context_cup_runner.toolathlon:ToolathlonAgent`, with
`PYTHONPATH=course/runner/src` so harbor's process can import them.

The agent class runs on the host inside harbor's process. Its `setup` uploads
the in-container loop and every package directory in `CC_HOST_DRIVER_CHAIN` into
the trial container and runs each `setup.sh` root to leaf. It then creates
`ccdriver`, finds a way to switch to it that works in the image (`setpriv`,
`runuser`, or `su`, in that order; the trial fails if the image has none, or
cannot add a user), starts the proxy, and checks that `ccdriver` cannot read
its keys. Its `run` waits for the proxy, execs the loop inside the
container, stops the proxy, and reads `summary.json` back into harbor's
`AgentContext`.

Settings reach the agent class through `--agent-env`:

| var                    | value                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CC_HOST_DRIVER_CHAIN` | host paths of every package in the chain, root to leaf, colon separated (the suite resolves `extends`). harbor layers these values over every exec the agent runs, so the container-side list travels under `CC_DRIVER_CHAIN` instead |
| `CC_TARGET_JSON`       | the `target` object from input.json, as JSON                                                                                                                                                                                          |
| `CC_TURN_RETRIES`      | optional, default 3                                                                                                                                                                                                                   |
| `CC_MAX_STEPS`         | optional cap on turns, default per benchmark                                                                                                                                                                                          |
| `CC_SAVE_BODIES`       | optional; `1` has the proxy keep every request and response body                                                                                                                                                                      |

No provider key is forwarded with `--agent-env`: harbor layers those values
over every command the agent runs in the container, the loop's included.
The keys stay in harbor's own process env, where the tau3 user simulator and
verifier use them and the agent class reads them to hand to the trial's
proxy.

## Naming

Drivers shipped with the course are prefixed `base_`, one or two per lane:
`base_passthrough` sends the context payload unchanged and `base_truncate`
clips oversized tool results (Python engine), `base_pydantic` runs Pydantic
AI with no strategy (Pydantic engine), `base_litellm` trims with LiteLLM
(LiteLLM engine), and `base_codex` is OpenAI's Codex CLI (agent).
Contestants pick any other prefix.

## Agent drivers

A package with `"kind": "agent"` is a whole agent rather than a turn-protocol
driver: Codex, Claude Code, an agent framework that must run its own tools.
harbor runs it directly, so the package names the harbor agent class:

```json
{
  "name": "@context-cup-drivers/base_codex",
  "contextCup": {
    "kind": "agent",
    "harbor_agent": "context_cup_runner.codex:CodexAgent",
    "providers": ["openai"]
  }
}
```

The course's runner loop, `input.json`, and `output.json` do not apply. The
agent reaches the model through the proxy like everything else: the wrapper
class starts the same in-container proxy, stamps `OPENAI_BASE_URL` (or the
provider's equivalent) with the trial's prefix, and hands the agent the
placeholder key, so its own client goes through the proxy and a direct call
would fail with 401. harbor installs and runs these agents as root, so
unlike a script driver an agent driver could read the proxy's keys from
`/proc`; it is trusted as far as harbor's own agents are.

What a run of an agent driver has: the verifier's reward, the proxy's call
log (turn ids are null, calls are sequenced), cost, and, with body capture,
every request the agent sent. What it does not have: `context_payload`,
`original_payload`, or `state`, because the agent owns its conversation;
the results show such drivers by name only, and they are compared on score
and cost.
