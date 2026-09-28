# base_agent

A whole agent written from scratch, in one Python file and no framework. It
gets harbor's instruction and the task's MCP servers and runs its own loop:
send the conversation to the model, run the tools the model asks for on the
MCP servers, append the results, repeat until the model answers without a
tool call. It clips any tool result over `max_bytes`, like `base_python`, so
the two compare: same strategy, but the agent owns the loop and the course
only scores it.

- **Kind**: `agent`, a script agent: no `harbor_agent`; the course sets the
  benchmark up as its turn loop would (tau3's seed, Toolathlon's agent
  prompt) and runs `agent.sh` once per trial, as the unprivileged
  `ccdriver`, after its dependencies are installed. See "Agent drivers" in
  [docs/protocol.md](../../docs/protocol.md) for what it is handed.
- **Providers**: `openai`, `anthropic`, `gemini`. The conversation is one
  plain list of chat messages, and [LiteLLM](https://github.com/BerriAI/litellm)
  carries it to whichever provider the run targets, through the trial's
  proxy (OpenAI's through its Responses API, like every other driver). Each reply goes back into the list as LiteLLM's own message, which
  keeps Gemini's thought signatures and Anthropic's thinking blocks; OpenAI's
  encrypted reasoning has no chat form and is not carried.
- **Prompt**: the benchmark's system prompt when the course hands one over
  (`CC_SYSTEM_PROMPT`, Toolathlon's), else a short generic one; harbor's
  instruction is the first user message (on tau3 it carries the policy).
- **Tools**: every tool the task's MCP servers list, except the ones the
  course reserves for the harness (`CC_HARNESS_TOOLS`, tau3's runtime
  controls), which would undo the trial's setup.
- **Config**: `max_bytes` (default `100000`), the largest tool result sent
  whole, from `[tool.context-cup.config]`, handed over as `CC_CONFIG`.
- **Files**: `agent.py` (the agent), `agent.sh` (runs it), `pyproject.toml`
  and `uv.lock` (LiteLLM and the MCP client, which the runner installs into
  a venv at `$CC_SELF_DIR/.venv`), `test_base_agent.py`
  (`uv run pytest drivers/base_agent`).

```
bin/suite smoke_tau --driver base_agent --target gpt-5.5@medium
bin/suite smoke_toolathlon --driver base_agent --target claude-sonnet-4-6
```

**What a run gives**: the verifier's reward, every model call with tokens and
cost from the proxy's log, and, from what the agent writes to
`$CC_RESULT_FILE`, a summary (stop reason, turns, tool calls). The result
file also keeps the final message list, in the trial's agent directory. The
agent's output is the trial's `runner.txt`.

**Make your own**: copy the directory and rename the package. A context
strategy is whatever you do to `messages` before each call: trim it,
summarise the old part with a cheaper model (`litellm.acompletion` with
`extra_headers={"x-cc-purpose": "summarize"}` labels that call in the
accounting), or keep notes outside it. Anything else, from a planner to
subagents, is yours to add. An agent in another language needs only a
different `agent.sh`, with a `setup.sh` to install its toolchain: the
contract is environment variables, MCP servers, and the proxy.
