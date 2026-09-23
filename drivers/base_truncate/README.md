# base_truncate

Clips every tool result larger than `max_bytes` before it reaches the model,
leaving a marker with the number of bytes removed. The simplest strategy
that is not nothing, and the example of editing through the provider-neutral
view.

- **Lane**: [`engines/python`](../../engines/python); one edit through
  `ctx.view()` and `ctx.write()` serves every provider, and the native payload
  changes only where a result was clipped.
- **Providers**: `openai`, `anthropic`, `gemini` (the OpenAI and Anthropic
  SDKs, and a direct POST for Gemini).
- **Config**: `max_bytes` (default `100000`), the largest tool result sent
  whole.
- **Files**: `driver.py`, `setup.sh` (installs `openai`, `anthropic`, `httpx`).

```
bin/suite smoke_tau --driver base_truncate --target gpt-5.5@medium
bin/suite toolathlon_local --driver base_truncate --target claude-sonnet-4-6
```

**Make your own**: copy the directory and change the loop in `run`: any
edit to `conversation.messages` (text, removals, additions) goes back with
`ctx.write(conversation)`. Keep each tool call with its result; a provider
rejects either half on its own. Put tunables in `contextCup.config`.
