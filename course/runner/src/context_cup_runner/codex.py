"""OpenAI's Codex CLI as a whole-agent driver.

harbor's own Codex agent does the work: it installs the CLI in the trial
container, writes its config with the task's MCP servers, runs `codex exec`,
and turns the session into a trajectory. This wrapper only points it at the
course's proxy, one prefix per trial, and forwards the target's reasoning
effort. Codex owns its loop and its context; the course sees its calls
through the proxy and scores it like any other driver.
"""

from __future__ import annotations

import json
from typing import Any

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment

PLACEHOLDER_KEY = "cc-proxy"


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


class CodexAgent(Codex):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        extra_env = kwargs.get("extra_env") or {}
        effort = reasoning_effort_from_target(dict(extra_env))
        if effort and "reasoning_effort" not in kwargs:
            kwargs["reasoning_effort"] = effort
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
        ends up with the per-trial URL and no real key."""
        proxy_url = self._extra_env.get("CC_PROXY_URL")
        if not proxy_url:
            raise RuntimeError(
                "CC_PROXY_URL is required: the codex driver reaches the model "
                "only through the course proxy"
            )
        self._extra_env["OPENAI_BASE_URL"] = proxy_base_url(proxy_url, self.trial_id())
        self._extra_env["OPENAI_API_KEY"] = PLACEHOLDER_KEY

    async def install(self, environment: BaseEnvironment) -> None:
        self.route_through_proxy()
        await super().install(environment)
