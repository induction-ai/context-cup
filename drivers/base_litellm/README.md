# base_litellm

LiteLLM's own trimming: the working conversation is cut to fit the model's
context window with `litellm.utils.trim_messages`, any tool call separated
from its result is dropped, and the trimmed list is kept for the next turn.
The default for litellm-based drivers.

- **Lane**: [`engines/litellm`](../../engines/litellm); chat messages in
  `ctx.context_messages`, calls through `ctx.llm`.
- **Providers**: `openai`, `anthropic`, `gemini`.
- **Config**: `max_tokens`, the budget for the trim. Unset, litellm uses 75%
  of the model's input window, which most tasks never reach, so the driver
  then behaves like a passthrough. Set it lower to make it bite.
- **Files**: `driver.py`, `test_driver.py` (`uv run pytest drivers`). No
  `setup.sh`: the engine installs litellm.

```
bin/suite smoke_tau --driver base_litellm --target claude-sonnet-4-6
```

**Make your own**: copy the directory, edit `ctx.context_messages` in `run`,
and return `ctx.llm.completion()`. Whatever the list holds when `run` returns
persists. Reuse `keep_tool_pairs` after any cut that can split a call from
its result.
