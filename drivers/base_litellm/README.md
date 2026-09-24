# base_litellm

Clips every tool result larger than `max_bytes` before it reaches the model,
leaving a marker with the number of bytes removed: `base_python`, on
LiteLLM. The smallest driver on the LiteLLM engine that does something, and
the example of editing chat messages.

- **Lane**: [`engines/litellm`](../../engines/litellm); chat messages in
  `ctx.context_messages`, calls through `ctx.llm`.
- **Providers**: `openai`, `anthropic`, `gemini`.
- **Config**: `max_bytes` (default `100000`), the largest tool result sent
  whole.
- **Files**: `driver.py`, `test_base_litellm.py` (`uv run pytest drivers`).
  No `setup.sh`: the engine installs litellm.

```
bin/suite smoke_tau --driver base_litellm --target claude-sonnet-4-6
```

**Make your own**: copy the directory, edit `ctx.context_messages` in `run`,
and return `ctx.llm.completion()`. Whatever the list holds when `run` returns
persists. Keep each tool call with its result; a provider rejects either
half on its own. Put tunables in `contextCup.config`.
