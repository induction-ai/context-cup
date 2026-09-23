# base_passthrough

No context management: every turn sends the full conversation the course
built to the model, unchanged. The baseline every other driver is measured
against, and the smallest Python-engine driver.

- **Lane**: [`engines/python`](../../engines/python), native OpenAI Responses
  payloads.
- **Providers**: `openai`.
- **Config**: none.
- **Files**: `driver.py` (one call), `setup.sh` (installs the `openai` SDK
  into the engine's venv).

```
bin/suite smoke_tau --driver base_passthrough --target gpt-5.5@medium
```

**Make your own**: copy the directory, rename the package in
`package.json`, and edit `ctx.context_payload` in `driver.py` before the
call. For one strategy across providers, start from
[`base_truncate`](../base_truncate) instead, which works through the
provider-neutral view.
