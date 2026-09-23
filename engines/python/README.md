# Python engine

A driver is `driver.py` with one function:

```python
from context_cup_engine import PythonContext
from openai import OpenAI


def run(ctx: PythonContext):
    return OpenAI().responses.create(**ctx.context_payload)
```

`run` makes the model call with whatever client it likes and returns the
provider's response: a dict, or the SDK's response object. The runner points
every SDK at the run's proxy (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`,
`GOOGLE_GEMINI_BASE_URL`, placeholder keys), so no configuration is needed.
Send an `x-cc-purpose` header on auxiliary calls to label them.

`ctx` carries the turn: `first`, `provider`, `target`, `original_payload`,
`dirs`, `turn_id`, the driver manifest's `config`, and the two things a driver
may change, `context_payload` and `state`. `ctx.view()` reads
`context_payload` as a provider-neutral conversation and `ctx.write(view)`
puts edits back, touching only what changed.

The engine installs no provider SDK. A driver brings its own in its
`setup.sh`, into the engine's venv:

```bash
uv pip install --quiet --python "${CC_CHAIN%%:*}/.venv/bin/python" openai
```

Tests: `uv run pytest engines/python`.
