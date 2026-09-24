"""OpenAI's Codex CLI as a whole-agent driver.

harbor's own Codex agent does the work: it installs the CLI in the trial
container, writes its config with the task's MCP servers, runs `codex exec`,
and turns the session into a trajectory. This wrapper starts the course's
proxy in the container, points Codex at it with a placeholder key, and
forwards the target's reasoning effort. Codex owns its loop and its context;
the course sees its calls through the proxy and scores it like any other
driver.

The CLI is pinned so every run measures the same agent. Codex cannot speak
SSE to an MCP server, so SSE servers (Toolathlon's gateway) are bridged
through `mcp-remote` as a stdio command, and every server is `required`: a
server that fails to start fails the run instead of leaving Codex working
the task with no tools.

Codex runs as root, as harbor installs it, so unlike a script driver it
could read the proxy's keys from /proc. Agent drivers are trusted to the
extent harbor's own agents are.
"""

from __future__ import annotations

import json
from typing import Any

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from .container import (
    PROXY_URL,
    probe_platform,
    start_proxy,
    stop_proxy,
    wait_for_proxy,
)

PLACEHOLDER_KEY = "cc-proxy"
CODEX_VERSION = "0.156.1"
MCP_REMOTE_VERSION = "0.14.3"
MCP_REMOTE_DIR = "/tmp/context-cup-mcp-remote"
MCP_REMOTE_COMMAND = f"{MCP_REMOTE_DIR}/node_modules/.bin/mcp-remote"


def proxy_base_url(proxy_url: str, trial_id: str) -> str:
    return f"{proxy_url.rstrip('/')}/t/{trial_id}/openai/v1"


def reasoning_effort_from_target(extra_env: dict[str, str]) -> str | None:
    raw = extra_env.get("CC_TARGET_JSON")
    if not raw:
        return None
    try:
        target = json.loads(raw)
    except json.JSONDecodeError:
        return None
    effort = target.get("reasoning_effort") if isinstance(target, dict) else None
    return effort if isinstance(effort, str) and effort else None


def bridge_mcp_servers(config: dict[str, Any], servers: list[Any]) -> dict[str, Any]:
    """Codex's config with each SSE server run through mcp-remote and every
    task server required."""
    configured = config.setdefault("mcp_servers", {})
    for server in servers:
        if getattr(server, "transport", None) == "sse":
            configured[server.name] = {
                "command": MCP_REMOTE_COMMAND,
                "args": [server.url, "--transport", "sse-only", "--allow-http"],
            }
        if server.name in configured:
            configured[server.name]["required"] = True
    return config


class CodexAgent(Codex):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        extra_env = kwargs.get("extra_env") or {}
        effort = reasoning_effort_from_target(dict(extra_env))
        if effort and "reasoning_effort" not in kwargs:
            kwargs["reasoning_effort"] = effort
        kwargs["version"] = CODEX_VERSION
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "context-cup-codex"

    def trial_id(self) -> str:
        return str(self.logs_dir.parent.name)

    def route_through_proxy(self) -> None:
        """Stamp this trial's proxy prefix into the env harbor resolves the
        model connection from. harbor reads OPENAI_BASE_URL and
        OPENAI_API_KEY through `_extra_env`, so the container's config.toml
        ends up with the in-container proxy's URL and no real key."""
        self._extra_env["OPENAI_BASE_URL"] = proxy_base_url(PROXY_URL, self.trial_id())
        self._extra_env["OPENAI_API_KEY"] = PLACEHOLDER_KEY

    def _build_effective_config(
        self, openai_base_url: str | None = None
    ) -> dict[str, Any]:
        config: dict[str, Any] = super()._build_effective_config(openai_base_url)
        return bridge_mcp_servers(config, list(self.mcp_servers or []))

    async def install(self, environment: BaseEnvironment) -> None:
        self.route_through_proxy()
        await super().install(environment)
        if any(
            getattr(server, "transport", None) == "sse"
            for server in self.mcp_servers or []
        ):
            await self.exec_as_agent(
                environment,
                command=(
                    "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                    f"npm install --prefix {MCP_REMOTE_DIR} "
                    f"mcp-remote@{MCP_REMOTE_VERSION}"
                ),
            )
        raw = self._extra_env.get("CC_TARGET_JSON")
        await start_proxy(
            self,
            environment,
            platform=await probe_platform(self, environment),
            target=json.loads(raw) if raw else None,
            save_bodies=self._extra_env.get("CC_SAVE_BODIES") == "1",
        )

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        await wait_for_proxy(self, environment)
        try:
            await super().run(instruction, environment, context)
        finally:
            await stop_proxy(self, environment)
