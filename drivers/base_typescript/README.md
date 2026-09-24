# base_typescript

Clips every tool result larger than `max_bytes` before it reaches the model,
leaving a marker with the number of bytes removed: `base_python`, in
TypeScript. The smallest driver on the TypeScript engine that does
something, and the example of editing through the provider-neutral view with
npm SDKs.

- **Lane**: [`engines/typescript`](../../engines/typescript); one edit
  through `ctx.view()` and `ctx.write()` serves every provider, and the
  native payload changes only where a result was clipped.
- **Providers**: `openai`, `anthropic`, `gemini` (the `openai` and
  `@anthropic-ai/sdk` packages, and `fetch` for Gemini).
- **Config**: `max_bytes` (default `100000`), the largest tool result sent
  whole.
- **Files**: `driver.ts`; its npm packages are ordinary `dependencies` in
  `package.json`, bundled on the host by the engine's `build.sh`.

```
bin/suite smoke_tau --driver base_typescript --target gpt-5.5@medium
bin/suite toolathlon_local --driver base_typescript --target claude-sonnet-4-6
```

**Make your own**: copy the directory, rename the package in
`package.json`, `pnpm install`, and change the loop in `run`: any edit to
`conversation.messages` (text, removals, additions) goes back with
`ctx.write(conversation)`. Keep each tool call with its result; a provider
rejects either half on its own. Put tunables in `contextCup.config`.
