# observation_masking

A reproduction of **observation masking** from [The Complexity Trap: Simple
Observation Masking Is as Efficient as LLM Summarization for Agent Context
Management](https://arxiv.org/abs/2508.21433) (Lindenbauer et al., NeurIPS
2025), the default context manager in SWE-agent and the usual baseline in
later context-management papers.

## The strategy

Every tool result older than the last `window` assistant turns is replaced
with a one-line placeholder:

```
Old environment output: (37 lines omitted)
```

Everything else stays: the system prompt, every user message, and all of the
agent's reasoning and tool calls. The agent can still see what it did and in
what order, just not the old raw outputs; if it needs one again it can call
the tool again. There are no extra model calls.

The paper found, on SWE-bench Verified across five models, that this
roughly halves cost compared with an unmanaged agent and matches LLM
summarization's solve rate. This driver is here to show how that holds up
on medium-horizon, tool-heavy tasks with prompt caching like Tau Banking and Toolathlon.

## Faithful to the paper

- **Window** is `10`, the paper's setting (it found 10 better than 20).
- **A turn** is one assistant message that calls tools; its parallel calls'
  results are kept or masked together, as one observation was in the paper.
- **Placeholder** is SWE-agent's wording. The paper gives only an example,
  so the line count is the original result's, computed once.
- **No truncation.** Results inside the window go to the model whole.

## What to expect here

- **Short runs mask little.** Nothing is masked until turn 11, so on tasks
  of about 20 turns roughly half the results are ever masked, and only late.
- **It works against prompt caching.** Providers cache the longest
  unchanged prefix. Each turn past the window masks one more result, which
  changes the payload at that point, so the last ~`window` turns are re-read
  at the uncached price every turn. The paper's cost figures were only partly
  cache-aware. A masked result reads the same on every later turn, so the
  prefix before it stays cached; masking in batches would recover more, but
  isn't what the paper did.

## Config

| key      | default | what it does                                                  |
| -------- | ------- | ------------------------------------------------------------- |
| `window` | `10`    | tool results from this many recent assistant turns stay whole |

- **Lane**: [`engines/python`](../../engines/python), through `ctx.view()`
  and `ctx.write()`, so reasoning items, thinking blocks, and thought
  signatures ride along untouched and only masked results change.
- **Providers**: `openai`, `anthropic`, `gemini`.
- **Files**: `driver.py`, `test_observation_masking.py`
  (`uv run pytest drivers`).

```
bin/suite smoke_tau --driver observation_masking
bin/suite tau_banking --driver observation_masking --count 2
bin/suite toolathlon_local --driver observation_masking --count 2
```
