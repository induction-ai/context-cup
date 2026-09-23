# Pydantic engine

The Pydantic AI lane: a driver chooses [Pydantic AI](https://ai.pydantic.dev)
capabilities, typically context strategies from the
[Pydantic AI Harness](https://github.com/pydantic/pydantic-ai-harness), and
the engine runs the turn with them. Start from
[`base_pydantic`](../../drivers/base_pydantic); the overview is
[docs/drivers.md](../../docs/drivers.md). OpenAI only for now.

```python
from pydantic_ai_harness.compaction import ClearToolResults


def run(ctx):
    return [ClearToolResults(max_tokens=60_000, keep_pairs=3)]
```

## What comes in

`ctx` is a `PydanticContext`, there to inform your choice of capabilities.
Everything on it is read only as far as your driver is concerned.

| attribute              | type           | example                                                                          | lifetime                                                                                               |
| ---------------------- | -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ctx.first`            | `bool`         | `True`                                                                           | true on the trial's first turn                                                                         |
| `ctx.provider`         | `ProviderInfo` | `name="openai"`, `api_key="cc-proxy"`, `client.base_url="…/t/<trial>/openai/v1"` | fixed for the trial                                                                                    |
| `ctx.target`           | `Target`       | `model="gpt-5.5"`, `reasoning_effort="medium"`                                   | fixed for the trial                                                                                    |
| `ctx.config`           | `dict`         | `{"keep_pairs": 3}`                                                              | your `package.json` `contextCup.config`                                                                |
| `ctx.dirs`             | `Dirs`         | `turn="/logs/agent/turns/003_k3v9xq"`, `state="/logs/agent/driver_state"`        | `turn` new each turn; the engine keeps the agent's history in `state/pydantic_history.json`            |
| `ctx.context_payload`  | `dict`         | the course's native OpenAI request body                                          | informational: the agent's real context is its own history, not this                                   |
| `ctx.original_payload` | `dict`         | the full record, same shape                                                      | the course's record, appended each turn                                                                |
| `ctx.state`            | any JSON       | `{"summaries": 2}`                                                               | yours: persists to the next turn; the engine keeps its own bookkeeping in files under `ctx.dirs.state` |
| `ctx.turn`             | `TurnInput`    | the whole `input.json`                                                           | read only                                                                                              |

## What you return

One of:

- **a list of capabilities**, e.g. `[]` or
  `[ClearToolResults(...), SlidingWindowCompaction(...)]`. The engine builds
  `Agent(capabilities=...)` around them.
- **an `Agent`**, for more than capabilities: your own instructions, model
  settings, history processors, or toolsets. The engine keeps those and still
  sets the connection (below). A model name the Agent carries is kept; without
  one it gets the target.

Anything else fails the turn. The engine returns the raw OpenAI response of
the agent's final model call this turn as the turn's `response`.

## What the engine owns

Each turn the engine:

- loads the agent's own message history from `ctx.dirs.state`, and saves it
  again after the run;
- turns the course's new input since last turn into agent input: the task
  or the simulated user's reply becomes the prompt, and tool results become
  deferred tool results; on the first turn a canned greeting before the task
  is seeded into the history;
- adds the course's tools as external tools, so the agent stops and hands
  their calls back to the course instead of running them, and uses the
  payload's system text unless your Agent has instructions of its own;
- builds the model on the proxy (`ctx.provider.client.base_url` and the
  placeholder key) over the Responses API, with the target's reasoning effort
  when the model is the target's;
- runs the agent once. Tools your capabilities own (for example
  `ToolOutputLimits`' read-back tool) run inside that run and never reach the
  course. The run ends when the model calls one of the course's tools or
  answers in text.

Because Pydantic AI keeps its own history, the course's `context_payload`
does not reflect what the model saw; the proxy's request bodies do
(`CC_SAVE_BODIES=1`).

## A worked example

Clear old tool results when the history grows, then fall back to a sliding
window, tuned from `config`:

```python
from pydantic_ai_harness.compaction import ClearToolResults, SlidingWindowCompaction


def run(ctx):
    budget = int(ctx.config.get("max_tokens", 80_000))
    return [
        ClearToolResults(max_tokens=budget, keep_pairs=3),
        SlidingWindowCompaction(max_tokens=budget * 2, keep_messages=40),
    ]
```

A capability that needs a package beyond `pydantic-ai-slim[openai]` and
`pydantic-ai-harness` goes in your driver's `setup.sh`:
`uv pip install --python "${CC_CHAIN%%:*}/.venv/bin/python" <package>`.

Tests: `uv run pytest engines/pydantic`.
