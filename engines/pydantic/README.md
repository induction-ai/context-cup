# Pydantic engine

A driver's `run(ctx)` returns Pydantic AI capabilities, typically context
strategies from the Pydantic AI Harness:

```python
from pydantic_ai_harness.compaction import TieredCompaction


def run(ctx):
    return [TieredCompaction()]
```

The engine builds the agent and runs the turn: the target model on the
Responses API through the run's proxy, the course's tools as external tools
(the course runs them), the saved history, and the course's new tool results
and user text. It returns the raw provider response behind the agent's move.
A driver may return a whole `Agent` instead; its instructions, settings, and
own toolsets are kept, and a model name it chose is kept but routed through
the proxy.

`ctx` is read only: `first`, `provider`, `target`, `config`, `state`,
`dirs`, and the payloads. OpenAI only for now.

Tests: `uv run pytest engines/pydantic`.
