# Python engine

Turns the driver protocol (`docs/protocol.md`) into one Python function. A
driver that extends `@context-cup/engine-python` ships a `driver.py` with:

```python
def run(ctx):
    """Call the model and return the provider's response object."""
    return ctx.call(ctx.context_payload)
```

`ctx` is the parsed `input.json` plus helpers:

| field / method                      | meaning                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `ctx.first`                         | true on the first turn of the trial                                                        |
| `ctx.provider`                      | `openai`, `anthropic`, or `gemini`                                                         |
| `ctx.target`                        | model and reasoning effort                                                                 |
| `ctx.context_payload`               | the working request body; edit it in place or replace it                                   |
| `ctx.original_payload`              | the immutable record; read only                                                            |
| `ctx.state`                         | any JSON; whatever is here after `run` is echoed next turn                                 |
| `ctx.dirs`                          | `turn`, `state`, and `workspace` directories                                               |
| `ctx.config`                        | the `contextCup.config` block from the driver's package.json                               |
| `ctx.call(payload, purpose="turn")` | POST `payload` through the proxy and return the response object; `purpose` labels the call |

The driver makes the model call. `ctx.call` is a convenience that posts the
payload to `provider.client.base_url`, the run's proxy, and retries on 429
and 5xx; a driver is equally free to use the provider's SDK or any other
client, which the environment already points at the proxy. The proxy holds
the keys and does the accounting, so nothing here records calls.

What the engine writes after `run` returns: `response` is the return value,
`context_payload` is `ctx.context_payload` as the driver left it, `state` is
`ctx.state`.

## Files

- `setup.sh` creates this engine's venv on a uv-managed Python 3.12 and
  installs the package. A driver that needs more adds its own `setup.sh`,
  which runs after this one.
- `run.sh` is the per-turn entry the driver inherits.

## Tests

```
uv run pytest engines/python
uv run mypy
```
