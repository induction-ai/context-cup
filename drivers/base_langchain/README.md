# base_langchain

A whole agent on [LangChain](https://github.com/langchain-ai/langchain), in
one Python file. `create_agent` runs the loop: send the conversation to the
model, run the tools the model asks for, append the results, repeat until the
model answers without a tool call. The tools are the task's MCP servers,
through langchain-mcp-adapters. It clips any tool result over `max_bytes`,
like `base_python` and `base_agent`, so the three compare: same strategy, as
LangChain middleware, with the framework owning the loop.

- **Kind**: `agent`, a script agent: no `harbor_agent`; the course sets the
  benchmark up as its turn loop would (tau3's seed, Toolathlon's agent
  prompt) and runs `agent.sh` once per trial, as the unprivileged
  `ccdriver`, after its dependencies are installed. See "Agent drivers" in
  [docs/protocol.md](../../docs/protocol.md) for what it is handed.
- **Providers**: `openai`, `anthropic`, `gemini`, each through its own
  LangChain chat model (`ChatOpenAI` on the Responses API, like every other
  driver; `ChatAnthropic`; `ChatGoogleGenerativeAI`), pointed at the trial's
  proxy. Each carries what its next call needs back: OpenAI's encrypted
  reasoning items, Anthropic's thinking blocks, Gemini's thought signatures.
  The target's reasoning effort is passed as the course's own setting for
  the provider: OpenAI's `reasoning.effort`, a thinking budget on the
  others.
- **Prompt**: the benchmark's system prompt when the course hands one over
  (`CC_SYSTEM_PROMPT`, Toolathlon's), else a short generic one; harbor's
  instruction is the first user message (on tau3 it carries the policy).
- **Tools**: every tool the task's MCP servers list, except the ones the
  course reserves for the harness (`CC_HARNESS_TOOLS`, tau3's runtime
  controls), which would undo the trial's setup. One session per server is
  held for the whole trial, as the course's own loop holds it. A turn's tool calls run one at a time, in order, as the
  course's own loop runs them: tau3's runtime logs each call for its
  verifier, and concurrent calls interleave the log, which fails the
  trial's scoring.
- **Config**: `max_bytes` (default `100000`), the largest tool result sent
  whole, from `[tool.context-cup.config]`, handed over as `CC_CONFIG`.
- **Files**: `agent.py` (the agent), `agent.sh` (runs it), `pyproject.toml`
  and `uv.lock` (LangChain, its provider packages, and the MCP adapter,
  which the runner installs into a venv at `$CC_SELF_DIR/.venv`),
  `test_base_langchain.py`.

```
bin/suite smoke_tau --driver base_langchain --target gpt-5.5@medium
bin/suite smoke_toolathlon --driver base_langchain --target claude-sonnet-4-6
```

The tests need the driver's own packages, which the workspace's venv does
not hold (there they skip); run them from the driver's own project:

```
bin/test_agents` (or `uv run --project drivers/base_langchain --with pytest pytest drivers/base_langchain
```

**What a run gives**: the verifier's reward, every model call with tokens and
cost from the proxy's log, and, from what the agent writes to
`$CC_RESULT_FILE`, a summary (stop reason, turns, tool calls). The result
file also keeps the final message list, in the trial's agent directory. The
agent's output is the trial's `runner.txt`.

**Make your own**: copy the directory and rename the package. The context
strategy is middleware: `clip_tool_results` wraps every tool call (a
`wrap_tool_call`), `retry_empty_replies` every model call (a
`wrap_model_call`), and `ModelCallLimitMiddleware` is the step cap. Replace
or add to them: LangChain's own `SummarizationMiddleware` and
`ContextEditingMiddleware` (`langchain.agents.middleware`) are context
strategies ready to try, and a `before_model` hook of your own sees the
whole conversation before each call. A summary made with a cheaper model
from the same provider counts in your cost; label such calls with the
header `x-cc-purpose` (`default_headers` on the chat model).
