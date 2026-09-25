# course/runner

The harbor agent that runs one trial and manages the conversation as two
provider-native payloads: the immutable original and the driver's working
copy. Each turn it hands both to the driver through the file protocol in
[docs/protocol.md](../../docs/protocol.md) and appends the provider response
and the tool results that come back.

## What runs where

| piece                                  | where                         | job                                                                                                                                                                                                                                           |
| -------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tau3.py`, `toolathlon.py`, `host.py`  | host, inside harbor's process | upload the runner and the driver chain into the container, run each `setup.sh`, start the proxy, exec the loop, read `summary.json` back into harbor                                                                                          |
| `container.py`                         | host, inside harbor's process | `node` (for the proxy, and `CC_NODE` for driver scripts), the trial's proxy (upload the bundle, hand it the keys, start, wait, stop) and `ccdriver`, the unprivileged user driver scripts run as, with the check that it cannot read the keys |
| `uv_bootstrap.py`, `node_bootstrap.py` | host                          | fetch, verify (Node), and cache the `uv` and `node` binaries for the container's architecture and libc, under `~/.cache/context-cup/`                                                                                                         |
| `loop.py`                              | trial container               | the turn loop: writes `turns/NNN_xxxxxx/input.json`, runs the chain's `run.sh`, appends the response to both payloads, dispatches environment tool calls, runs `teardown.sh`, writes the artifacts                                            |
| `providers/`                           | trial container               | one adapter per provider: builds the first request body, reads a response's text and tool calls, appends responses, tool results and user turns in the provider's own format                                                                  |
| `envs/tau3.py`                         | trial container               | talks to the tau3-runtime MCP sidecar (user simulator and domain tools)                                                                                                                                                                       |
| `envs/toolathlon.py`                   | trial container               | talks to the Toolathlon MCP gateway; a stop tool or a plain reply ends the trial; reaching the step cap fails it                                                                                                                              |
| `overlong.py`                          | trial container               | Toolathlon's overlong tool output: cuts a long result, saves it under a short id, and answers the four `local-*_overlong_tooloutput` tools that search and page it                                                                            |
| `chain.py`                             | both                          | the driver chain: packages root to leaf (`package.json` with a `contextCup` block) and their scripts                                                                                                                                          |
| `atif.py`                              | trial container               | builds `trajectory.json` (harbor ATIF-v1.7) from the original payload, through the adapter                                                                                                                                                    |

harbor selects the agent with `--agent context_cup_runner.tau3:Tau3Agent` or
`--agent context_cup_runner.toolathlon:ToolathlonAgent` and
`PYTHONPATH=course/runner/src`. tau3 jobs also pass
`--extra-docker-compose course/runner/tau3_docker_compose.yaml`.

## Settings

Passed by the suite with `--agent-env`; the host agent forwards them to the
loop.

| var                        | required | meaning                                                                                                              |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `CC_HOST_DRIVER_CHAIN`     | yes      | host package dirs root to leaf, colon separated; `node_modules` and similar are not uploaded                         |
| `CC_TARGET_JSON`           | yes      | `{provider, model, reasoning_effort}`                                                                                |
| `CC_SAVE_BODIES`           | no       | `1` has the proxy keep every request and response body under `bodies/`                                               |
| `CC_TURN_RETRIES`          | no       | retries per failed turn, default 3                                                                                   |
| `CC_EMPTY_RETRIES`         | no       | re-asks after an empty reply across the whole trial, default 3                                                       |
| `CC_MAX_STEPS`             | no       | turn cap, default 200 for tau3 and 150 for toolathlon                                                                |
| `CC_MAX_TOOL_OUTPUT_CHARS` | no       | toolathlon: results longer than this are cut, default 100000; the full text is saved under `.overlong_tool_outputs/` |
| `CC_TRUNCATE_TOOL_OUTPUT`  | no       | toolathlon: `on` (default), `off`, or `no_json` (cut everything but JSON)                                            |
| `CC_TURN_TIMEOUT_SEC`      | no       | wall clock for one `run.sh`, default 1800                                                                            |
| `CC_TOOL_TIMEOUT_SEC`      | no       | one MCP call, default 120 (tau3) or 270 (toolathlon)                                                                 |
| `CC_TAU3_SEED`             | no       | base seed, default 300; each trial derives its own from its name                                                     |
| `CC_TAU3_MAX_ERRORS`       | no       | runtime error budget, default 10                                                                                     |
| `CC_TOOLATHLON_BUNDLE`     | no       | default `/workspace/dumps/task_bundle.json`                                                                          |
| `CC_WORKSPACE_DIR`         | no       | default `/workspace/dumps/workspace`                                                                                 |

The loop itself reads `CC_BENCHMARK`, `CC_TRIAL_ID`, `CC_AGENT_DIR`,
`CC_INSTRUCTION_FILE`, `CC_PROXY_URL` (the in-container proxy,
`http://127.0.0.1:18080`), `CC_DRIVER_USER` and `CC_DRIVER_DROP` (who
`run.sh` and `teardown.sh` run as, and whether through `setpriv`, `runuser`,
or `su`), and the container-side `CC_DRIVER_CHAIN`, all set by the host
agent.

Provider keys never travel with `--agent-env`, which harbor applies to every
command in the container. The host agent reads them from harbor's own
process env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, and any `CC_UPSTREAM_*` override), uploads them to a
root-only file, and starts the proxy from it; the proxy deletes the file as
it starts. The proxy bundle is `CC_PROXY_BUNDLE` when set (bin/suite builds
it before a run), else `course/proxy/dist/proxy.cjs`.

## Artifacts

Under the trial's `agent/` directory: `turns/`, `calls.jsonl` (the proxy's
call log), `proxy.txt` (its output), `isolation.txt` (the key check),
`bodies/` with `CC_SAVE_BODIES=1`, `trajectory.json`, `summary.json`,
`original_payload.json`, `context_payload.json`, `runner.txt` (the loop's
output),
`setup_<package>.txt` per setup script, `scripts/teardown_<package>.txt`,
`driver_state/` and `.overlong_tool_outputs/`.

## Failures

A crash, a missing `output.json`, or a bad one uses one of the turn's
`CC_TURN_RETRIES`. An empty reply is discarded instead and uses one of the
trial's `CC_EMPTY_RETRIES`; running out ends the trial with `agent_error`
(which tau3's runtime records). An exception from the environment ends it
with `env_error`, any other with `runner_error`, and Toolathlon's step cap
with `max_steps`; each of these fails the trial rather than handing it to
the verifier, and `summary.json` carries the reason and the message. tau3's
runtime only accepts its own termination reasons, so every other reason
reaches it as `agent_error`.

## Tests

```
uv run pytest course/runner
bin/lint
```

The tests drive the loop with a fake two-package chain whose engine answers
in each provider's response format, and an in-memory environment. Nothing
touches the network, docker, or harbor. `tests/test_providers.py` covers the
adapters against hand-built API-shaped fixtures.

## Whole agents

`codex.py` wraps harbor's Codex agent as `context_cup_runner.codex:CodexAgent`
for `kind: agent` drivers. It sets the per-trial proxy base URL and the
placeholder key before harbor installs Codex, starts the same in-container
proxy after, stops it when Codex is done, and forwards the target's
reasoning effort. Codex runs as root, as harbor installs it, so it could
read the proxy's keys; nothing else from this package runs for such a
trial.
