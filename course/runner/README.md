# course/runner

The harbor agent that runs one trial and manages the conversation as two
provider-native payloads: the immutable original and the driver's working
copy. Each turn it hands both to the driver through the file protocol in
[docs/protocol.md](../../docs/protocol.md) and appends the provider response
and the tool results that come back.

## What runs where

| piece                                 | where                         | job                                                                                                                                                                                                |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tau3.py`, `toolathlon.py`, `host.py` | host, inside harbor's process | upload the runner and the driver chain into the container, run each `setup.sh`, exec the loop, read `usage.json` and `summary.json` back into harbor                                               |
| `loop.py`                             | trial container               | the turn loop: writes `turns/NNN_xxxxxx/input.json`, runs the chain's `run.sh`, appends the response to both payloads, dispatches environment tool calls, runs `teardown.sh`, writes the artifacts |
| `providers/`                          | trial container               | one adapter per provider: builds the first request body, reads a response's text and tool calls, appends responses, tool results and user turns in the provider's own format                       |
| `envs/tau3.py`                        | trial container               | talks to the tau3-runtime MCP sidecar (user simulator and domain tools)                                                                                                                            |
| `envs/toolathlon.py`                  | trial container               | talks to the Toolathlon MCP gateway; a stop tool or a plain reply ends the trial                                                                                                                   |
| `chain.py`                            | both                          | the driver chain: packages root to leaf (`package.json` with a `contextCup` block) and their scripts                                                                                               |
| `atif.py`                             | trial container               | builds `trajectory.json` (harbor ATIF-v1.7) from the original payload, through the adapter                                                                                                         |

harbor selects the agent with `--agent context_cup_runner.tau3:Tau3Agent` or
`--agent context_cup_runner.toolathlon:ToolathlonAgent` and
`PYTHONPATH=course/runner/src`. tau3 jobs also pass
`--extra-docker-compose course/runner/tau3_docker_compose.yaml`.

## Settings

Passed by the suite with `--agent-env`; the host agent forwards them to the
loop.

| var                        | required   | meaning                                                                                                                                            |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CC_HOST_DRIVER_CHAIN`     | yes        | host package dirs root to leaf, colon separated; `node_modules` and similar are not uploaded                                                       |
| `CC_TARGET_JSON`           | yes        | `{provider, model, reasoning_effort}`                                                                                                              |
| `OPENAI_API_KEY` etc       | per target | forwarded into the container; the loop puts the target's key into `input.json` as `provider.api_key` while the turn runs and redacts it afterwards |
| `CC_TURN_RETRIES`          | no         | retries per failed turn, default 2                                                                                                                 |
| `CC_MAX_STEPS`             | no         | turn cap, default 200 for tau3 and 150 for toolathlon                                                                                              |
| `CC_MAX_TOOL_OUTPUT_CHARS` | no         | tool results longer than this are clipped, default 100000; the full text is saved under `clipped_tool_outputs/`                                    |
| `CC_TURN_TIMEOUT_SEC`      | no         | wall clock for one `run.sh`, default 1800                                                                                                          |
| `CC_TOOL_TIMEOUT_SEC`      | no         | one MCP call, default 120 (tau3) or 270 (toolathlon)                                                                                               |
| `CC_TAU3_SEED`             | no         | base seed, default 300; each trial derives its own from its name                                                                                   |
| `CC_TAU3_MAX_ERRORS`       | no         | runtime error budget, default 10                                                                                                                   |
| `CC_TOOLATHLON_BUNDLE`     | no         | default `/workspace/dumps/task_bundle.json`                                                                                                        |
| `CC_WORKSPACE_DIR`         | no         | default `/workspace/dumps/workspace`                                                                                                               |

The loop itself reads `CC_BENCHMARK`, `CC_TRIAL_ID`, `CC_AGENT_DIR`,
`CC_INSTRUCTION_FILE` and the container-side `CC_DRIVER_CHAIN`, all set by
the host agent.

## Artifacts

Under the trial's `agent/` directory: `turns/`, `usage.json`,
`trajectory.json`, `summary.json`, `original_payload.json`,
`context_payload.json`, `runner.txt` (the loop's output),
`setup_<package>.txt` per setup script, `scripts/teardown_<package>.txt`,
`driver_state/` and `clipped_tool_outputs/`.

## Tests

```
uv run pytest course/runner
uv run ruff check course/runner
```

The tests drive the loop with a fake two-package chain whose engine answers
in each provider's response format, and an in-memory environment. Nothing
touches the network, docker, or harbor. `tests/test_providers.py` covers the
adapters against hand-built API-shaped fixtures.
