# Python engine

The native lane: `run(ctx)` gets the provider's own request body, calls the
model with whatever client it likes, and returns the provider's response.
Start from [`base_passthrough`](../../drivers/base_passthrough) or
[`base_python`](../../drivers/base_python); the overview is
[docs/drivers.md](../../docs/drivers.md).

```python
from openai import OpenAI


def run(ctx):
    return OpenAI().responses.create(**ctx.context_payload)
```

## What comes in

`ctx` is a `PythonContext` (`from context_cup_engine import PythonContext`).

| attribute              | type                     | example                                                                                                                         | lifetime                                                                                                                              |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.context_payload`  | `dict`                   | `{"model": "gpt-5.5", "instructions": "…", "input": [...], "tools": [...], "reasoning": {...}}`                                 | **persists**: leave in it the request you sent; the course appends the model's reply and the tool results and hands it back next turn |
| `ctx.original_payload` | `dict`                   | same shape, every message and result as it happened                                                                             | read only; the course appends to it each turn and never edits it                                                                      |
| `ctx.state`            | any JSON                 | `{"summarised": 4}`                                                                                                             | **persists**: whatever it holds when `run` returns comes back next turn; `{}` on turn one                                             |
| `ctx.first`            | `bool`                   | `True`                                                                                                                          | read only; true on the trial's first turn                                                                                             |
| `ctx.provider`         | `ProviderInfo`           | `name="openai"`, `api_key="cc-proxy"`, `client.base_url="http://127.0.0.1:18080/t/<trial>/openai/v1"`, `client.api="responses"` | read only, fixed for the trial                                                                                                        |
| `ctx.target`           | `Target`                 | `model="gpt-5.5"`, `reasoning_effort="medium"`                                                                                  | read only, fixed for the trial; already applied in the first payload                                                                  |
| `ctx.config`           | `dict`                   | `{"max_bytes": 100000}`                                                                                                         | read only; your `package.json` `contextCup.config`                                                                                    |
| `ctx.dirs`             | `Dirs`                   | `turn="/logs/agent/turns/003_k3v9xq"`, `state="/logs/agent/driver_state"`, `workspace=None`                                     | `turn` is new each turn; files in `state` survive the trial; `workspace` is the task's working directory on Toolathlon                |
| `ctx.turn_id`          | `str`                    | `"003_k3v9xq"`                                                                                                                  | new each turn, also each retry                                                                                                        |
| `ctx.turn`             | `TurnInput`              | the whole `input.json`, e.g. `ctx.turn.turn_index`, `ctx.turn.limits["max_steps"]`                                              | read only                                                                                                                             |
| `ctx.view()`           | `-> Conversation`        | `system`, `messages` (role `user`/`assistant`/`tool`, `text`, `tool_calls`, `tool_call_id`), `tools`                            | a fresh provider-neutral reading of `ctx.context_payload` each call                                                                   |
| `ctx.write(conv)`      | `(Conversation) -> None` | —                                                                                                                               | puts a view's edits back into `ctx.context_payload`, touching only what changed                                                       |

The payload shapes are the providers' own: OpenAI's Responses API (`input`
items), Anthropic's Messages API (`messages` with content blocks), Gemini's
`generateContent` (`contents` with parts). `ctx.view()` gives the same
conversation for all three, so one strategy can serve every provider:
reasoning items, thinking blocks, and thought signatures ride along untouched
inside it. Removing or adding messages through the view works too; keep each
tool call with its result, since a provider rejects either half on its own.

## What you return

The provider's response for the call that is your turn: the SDK's response
object (`openai`, `anthropic`), or its JSON as a `dict`. The engine writes it
to `output.json` with only the fields the provider sent. Anything else fails
the turn. Your auxiliary calls (summaries and the like) are not returned;
the proxy has already counted them.

## What the engine owns, and what it doesn't

The engine runs the turn mechanics: reads `input.json`, loads your
`driver.py`, writes `output.json` with your response, `ctx.context_payload`,
and `ctx.state`. It installs no provider SDK and makes no call: your
`setup.sh` installs the client, and the runner has already pointed every SDK
at the proxy (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`,
`GOOGLE_GEMINI_BASE_URL`, placeholder keys).

```bash
# drivers/<name>/setup.sh
uv pip install --quiet --python "${CC_CHAIN%%:*}/.venv/bin/python" openai
```

## A worked example

Summarise older, large tool results once with a cheaper model, keeping the
three newest verbatim. The summaries persist in `context_payload`, so each is
paid for once, and the header labels them in the accounting.

```python
from openai import OpenAI

client = OpenAI()


def run(ctx):
    conversation = ctx.view()
    results = [m for m in conversation.messages if m.role == "tool" and m.text]
    for message in results[:-3]:
        if len(message.text) > 2_000 and not message.text.startswith("[summary]"):
            summary = client.responses.create(
                model="gpt-5.4-mini",
                input=f"Summarise this tool output for later reference:\n\n{message.text}",
                extra_headers={"x-cc-purpose": "summarize"},
            )
            message.text = "[summary] " + summary.output_text
    ctx.write(conversation)
    return client.responses.create(**ctx.context_payload)
```

Tests: `uv run pytest engines/python`.
