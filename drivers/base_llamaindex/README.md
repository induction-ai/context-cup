# base_llamaindex

A whole agent on [LlamaIndex](https://github.com/run-llama/llama_index), in
one Python file. A `FunctionAgent` runs the loop: send the conversation to
the model, run the tools the model asks for, append the results, repeat until
the model answers without a tool call. The tools are the task's MCP servers,
through llama-index-tools-mcp. It clips any tool result over `max_bytes`,
like `base_python` and `base_agent`, so the three compare: same strategy, as
each tool's callback, with the framework owning the loop.

- **Kind**: `agent`, a script agent: no `harbor_agent`; the course sets the
  benchmark up as its turn loop would (tau3's seed, Toolathlon's agent
  prompt) and runs `agent.sh` once per trial, as the unprivileged
  `ccdriver`, after its dependencies are installed. See "Agent drivers" in
  [docs/protocol.md](../../docs/protocol.md) for what it is handed.
- **Providers**: `openai`, `anthropic`, `gemini`, each through its own
  LlamaIndex LLM class (`OpenAIResponses`, the Responses API like every
  other driver; `Anthropic`; `GoogleGenAI`), given the trial's proxy as its
  base URL. Anthropic's thinking blocks and Gemini's thought signatures are
  carried between calls; OpenAI's encrypted reasoning has no place in
  LlamaIndex's messages and is not. The target's reasoning effort is passed
  as the course's own setting for the provider: OpenAI's `reasoning.effort`,
  a thinking budget on the others.
- **Prompt**: the benchmark's system prompt when the course hands one over
  (`CC_SYSTEM_PROMPT`, Toolathlon's), else a short generic one; harbor's
  instruction is the first user message (on tau3 it carries the policy).
- **Tools**: every tool the task's MCP servers list, except the ones the
  course reserves for the harness (`CC_HARNESS_TOOLS`, tau3's runtime
  controls), which would undo the trial's setup. `McpToolSpec` turns each
  into a `FunctionTool` over a session this agent holds open per server for
  the whole trial, as the course's own loop holds it (the package's own
  client would open a session per call). A turn's tool calls run one at a time, in order, as the
  course's own loop runs them: tau3's runtime logs each call for its
  verifier, and concurrent calls interleave the log, which fails the
  trial's scoring.
- **Config**: `max_bytes` (default `100000`), the largest tool result sent
  whole, from `[tool.context-cup.config]`, handed over as `CC_CONFIG`.
- **Files**: `agent.py` (the agent), `agent.sh` (runs it), `pyproject.toml`
  and `uv.lock` (LlamaIndex, its provider packages, and the MCP tool spec,
  which the runner installs into a venv at `$CC_SELF_DIR/.venv`),
  `test_base_llamaindex.py`.

```
bin/suite smoke_tau --driver base_llamaindex --target gpt-5.5@medium
bin/suite smoke_toolathlon --driver base_llamaindex --target claude-sonnet-4-6
```

The tests need the driver's own packages, which the workspace's venv does
not hold (there they skip); run them from the driver's own project:

```
bin/test_agents` (or `uv run --project drivers/base_llamaindex --with pytest pytest drivers/base_llamaindex
```

**What a run gives**: the verifier's reward, every model call with tokens and
cost from the proxy's log, and, from what the agent writes to
`$CC_RESULT_FILE`, a summary (stop reason, turns, tool calls). The result
file also keeps the agent's memory as the run ended, in the trial's agent
directory. The agent's output is the trial's `runner.txt`.

**Make your own**: copy the directory and rename the package. The context
strategy is each tool's `async_callback` (`clipped`), which gets the raw MCP
result and returns what the model sees. For a strategy over the whole
conversation, give the `FunctionAgent` a memory of your own (`memory=` on
`agent.run`): LlamaIndex's `Memory` takes blocks that summarise or drop old
messages as the token count grows. A summary made with a cheaper model from
the same provider counts in your cost; label such calls with the header
`x-cc-purpose` (`default_headers` on the LLM).
