# base_aisdk

Clips every tool result larger than `max_bytes` before it reaches the model,
leaving a marker with the number of bytes removed: `base_python`, on the
AI SDK. The smallest driver on the AI SDK engine that does something, and
the example of editing AI SDK messages.

- **Lane**: [`engines/aisdk`](../../engines/aisdk); AI SDK messages in
  `ctx.contextMessages`, calls through `ctx.llm`.
- **Providers**: `openai`, `anthropic`, `gemini`.
- **Config**: `max_bytes` (default `100000`), the largest tool result sent
  whole.
- **Files**: `driver.ts`. No `setup.sh`: the engine bundles the AI SDK.

```
bin/suite smoke_tau --driver base_aisdk --target claude-sonnet-4-6
```

**Make your own**: copy the directory, rename the package, edit
`ctx.contextMessages` in `run`, and return `ctx.llm.generateText()`. Whatever
the list holds when `run` returns persists. Keep each tool call with its
result; a provider rejects either half on its own. Put tunables in
`contextCup.config`.
