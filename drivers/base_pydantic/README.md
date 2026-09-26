# base_pydantic

Clips every tool result larger than `max_bytes` before it reaches the model,
leaving a marker with the number of bytes removed: `base_python`, on
Pydantic AI. The example of returning a whole `Agent`, with its strategy as a
capability of its own.

- **Lane**: [`engines/pydantic`](../../engines/pydantic); `run(ctx)` returns
  an `Agent` and the engine runs it: connected to the target through the
  trial's proxy, with the course's tools, and its history kept between turns.
- **Providers**: `openai`.
- **Config**: `max_bytes` (default `100000`), the largest tool result sent
  whole.
- **Files**: `driver.py`, `test_base_pydantic.py` (`uv run pytest drivers`).
  No `setup.sh`: the engine installs Pydantic AI and the harness.

```
bin/suite smoke_tau --driver base_pydantic --target gpt-5.5@medium
```

**Make your own**: copy the directory and change the agent `run` returns.
Its capabilities are the strategy: a `ProcessHistory` of your own, as here,
which sees the whole history before every model call, or
[Pydantic AI Harness](https://github.com/pydantic/pydantic-ai-harness)
strategies such as `ClearToolResults(max_tokens=60_000, keep_pairs=3)` from
`pydantic_ai_harness.compaction`. Give the agent instructions or model
settings of its own and the engine keeps them. The agent keeps its own
history; use files under `ctx.dirs.state` for anything else, since the
engine uses `ctx.state`.
