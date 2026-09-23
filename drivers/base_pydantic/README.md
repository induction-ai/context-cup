# base_pydantic

Pydantic AI with no context strategy: the agent sees its whole history every
turn. The baseline for drivers built from
[Pydantic AI Harness](https://github.com/pydantic/pydantic-ai-harness)
capabilities.

- **Lane**: [`engines/pydantic`](../../engines/pydantic); `run(ctx)` returns
  a list of capabilities (here, an empty one) and the engine runs the agent.
- **Providers**: `openai`.
- **Config**: none.
- **Files**: `driver.py`. No `setup.sh`: the engine installs Pydantic AI and
  the harness.

```
bin/suite smoke_tau --driver base_pydantic --target gpt-5.5@medium
```

**Make your own**: copy the directory and return capabilities, for example
`[ClearToolResults(max_tokens=60_000, keep_pairs=3)]` from
`pydantic_ai_harness.compaction`, or a whole `Agent` when you need your own
instructions or settings. The agent keeps its own history; use files under
`ctx.dirs.state` for anything else, since the engine uses `ctx.state`.
