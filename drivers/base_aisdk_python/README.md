# base_aisdk_python

Clips every tool result larger than `max_bytes` before it reaches the model,
leaving a marker with the number of bytes removed: `base_python`, on the AI
SDK for Python. The smallest driver on the AI SDK for Python engine that does
something, and the example of editing AI SDK messages.

- **Lane**: [`engines/aisdk_python`](../../engines/aisdk_python); AI SDK
  messages in `ctx.context_messages`, calls through `ctx.llm`.
- **Providers**: `openai`, `anthropic` (the SDK has no Gemini provider).
- **Config**: `max_bytes` (default `100000`), the largest tool result sent
  whole.
- **Files**: `driver.py`, `test_base_aisdk_python.py` (`uv run pytest drivers`).
  No `setup.sh`: the engine installs the SDK.

```
bin/suite smoke_tau --driver base_aisdk_python
```

**Make your own**: copy the directory, edit `ctx.context_messages` in `run`,
and return `ctx.llm.generate()`. Whatever the list holds when `run` returns
persists. The SDK's parts are immutable, so an edited part is a copy put in
the old one's place. Keep each tool call with its result; a provider rejects
either half on its own. Put tunables in `[tool.context-cup.config]`.
