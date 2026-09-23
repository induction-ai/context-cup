# LiteLLM engine

The Python engine's shape in [LiteLLM](https://github.com/BerriAI/litellm)'s
terms: the conversation arrives as litellm chat messages instead of native
payloads, and `ctx.llm` is a litellm handle already set up for the run. A
driver edits `ctx.context_messages` if it wants to, and returns the litellm
response of the call that is its turn. One strategy serves OpenAI,
Anthropic, and Gemini. Start from
[`base_litellm`](../../drivers/base_litellm); the overview is
[docs/drivers.md](../../docs/drivers.md).

```python
def run(ctx):
    return ctx.llm.completion()  # the working conversation as it stands
```

## What comes in

`ctx` is a `LitellmContext`. Messages are plain `dict`s in OpenAI
chat-completions shape, typed as litellm's own `AllMessageValues`, the type
`litellm.completion(messages=...)` takes.

| attribute                                     | type                     | example                                                                                                                                               | lifetime                                                                                                                                                              |
| --------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.context_messages`                        | `list[AllMessageValues]` | `[{"role": "system", …}, {"role": "user", …}, {"role": "assistant", "tool_calls": […]}, {"role": "tool", "tool_call_id": "call_9", "content": "42"}]` | **persists**: turn one gets the whole conversation; after that, last turn's list as you left it, plus what came in since (the model's reply, tool results, user text) |
| `ctx.original_messages`                       | `list[AllMessageValues]` | the whole record, same shape                                                                                                                          | read only; rebuilt from the course's record each turn                                                                                                                 |
| `ctx.tools`                                   | `list[dict]`             | `[{"type": "function", "function": {"name": "get_balance", "parameters": {…}}}]`                                                                      | the course's tools in chat form, each turn                                                                                                                            |
| `ctx.llm`                                     | `LLM`                    | `ctx.llm.completion()`                                                                                                                                | new each turn; see below                                                                                                                                              |
| `ctx.state`                                   | any JSON                 | `{"summarised_through": 12}`                                                                                                                          | **persists**, and is yours alone; `{}` on turn one                                                                                                                    |
| `ctx.first`                                   | `bool`                   | `True`                                                                                                                                                | true on the trial's first turn                                                                                                                                        |
| `ctx.provider`                                | `ProviderInfo`           | `name="anthropic"`, `api_key="cc-proxy"`, `client.base_url="…/t/<trial>/anthropic/v1"`                                                                | fixed for the trial                                                                                                                                                   |
| `ctx.target`                                  | `Target`                 | `model="claude-sonnet-4-6"`, `reasoning_effort=None`                                                                                                  | fixed for the trial                                                                                                                                                   |
| `ctx.config`                                  | `dict`                   | `{"max_tokens": 60000}`                                                                                                                               | your `package.json` `contextCup.config`                                                                                                                               |
| `ctx.dirs`                                    | `Dirs`                   | `turn="/logs/agent/turns/003_k3v9xq"`, `state="/logs/agent/driver_state"`                                                                             | files in `state` survive the trial; the engine keeps its own `litellm_context.json` there                                                                             |
| `ctx.context_payload`, `ctx.original_payload` | `dict`                   | the course's native request bodies                                                                                                                    | informational; the messages above are built from them                                                                                                                 |
| `ctx.turn`                                    | `TurnInput`              | the whole `input.json`                                                                                                                                | read only                                                                                                                                                             |

`ctx.llm.completion(messages=None, *, purpose="turn", **kwargs)` is
`litellm.completion` with the run's connection filled in. Defaults:
`messages=ctx.context_messages`, `tools=ctx.tools`, the target model, and
its reasoning effort. Every argument can be overridden, `model` included: a
bare name is on the run's provider, and `openai/…`, `anthropic/…`,
`gemini/…` pick another, still through the proxy. `purpose` labels the call
in the accounting. Call it as often as you like. It returns litellm's
`ModelResponse`; `response.choices[0].message` is a litellm `Message`
object, so call `model_dump()` on it before putting it into
`ctx.context_messages` yourself (rarely needed: the engine adds the model's
reply next turn).

## What you return

A response from `ctx.llm.completion(...)`, the one that is your turn. The
engine emits the raw provider body of that exact call as the turn's
`response`. It must be a call on the run's provider; a response from anywhere
else, or anything that is not a response, fails the turn. What
`ctx.context_messages` holds when `run` returns is kept for the next turn.

## What the engine owns

The connection on every call: the litellm route for the model (OpenAI over
the Responses API, the wire the course speaks), the proxy base URL for the
call's provider, the placeholder key, `store: false` on OpenAI, and the
`x-cc-purpose` header. It captures each call's raw body, persists
`ctx.context_messages`, and folds each turn's new input into it. Gemini's
thought signatures are carried on their function calls, where litellm reads
them back (without them Gemini 3 loses its reasoning between turns).

## The trade

Chat messages are the convenient common format, and a lossy one: OpenAI's
encrypted reasoning items and Anthropic's thinking blocks have no chat form
and are not carried. Drivers that need those work with the native payload on
`engines/python`. LiteLLM is pinned to the version the workspace resolves
beside Pydantic AI, so the tests exercise what trial containers install.

## A worked example

Summarise all but the three newest tool results with a cheaper model, once
each. The edits persist, so a result is summarised a single time, and
replacing only the content keeps every tool call paired with its result,
which providers require.

```python
KEEP = 3


def run(ctx):
    results = [i for i, m in enumerate(ctx.context_messages) if m["role"] == "tool"]
    for i in results[:-KEEP]:
        message = ctx.context_messages[i]
        if str(message["content"]).startswith("[summary]"):
            continue
        summary = ctx.llm.completion(
            messages=[
                {"role": "user", "content": f"Summarise:\n\n{message['content']}"}
            ],
            model="openai/gpt-5.4-mini",
            tools=None,
            purpose="summarize",
        )
        ctx.context_messages[i] = {
            **message,
            "content": "[summary] " + summary.choices[0].message.content,
        }
    return ctx.llm.completion()
```

Tests: `uv run pytest engines/litellm`.
