# base_codex

OpenAI's Codex CLI working the task itself, as a whole agent. harbor runs it
through its own Codex agent: installs the CLI in the trial container, writes
its config with the task's MCP servers, and runs `codex exec`. The course's
turn loop does not apply.

- **Kind**: `agent`. `package.json` names the harbor class,
  `context_cup_runner.codex:CodexAgent`; there is no `driver.py`.
- **Providers**: `openai`.

```
bin/suite smoke_tau --driver base_codex --target gpt-5.5@medium
```

**What a run gives**: the verifier's reward; every model call, with tokens
and cost, from the proxy's log; turn and tool-call counts from harbor's
trajectory of the session (`agent/trajectory.json` in the trial directory,
one turn per agent step); and, with `CC_SAVE_BODIES=1`, every request Codex
sent, which shows what it kept in context and where it compacted.

**What it doesn't**: `context_payload`, `original_payload`, `state`, or turn
directories, because Codex owns its conversation. It is compared with other
drivers on score and cost.

**How it reaches the model**: `CodexAgent` (`course/runner`) subclasses
harbor's Codex agent. Before harbor installs Codex it sets `OPENAI_BASE_URL`
to this trial's prefix on the run's proxy and `OPENAI_API_KEY` to the
placeholder, so the container's Codex config points at the proxy and holds
no real key. It also passes the target's reasoning effort to Codex.

**Make your own**: another whole agent (Claude Code, Gemini CLI) is the same
kind of package plus a small wrapper class like `CodexAgent` that points the
agent's base-URL variable at the proxy.
