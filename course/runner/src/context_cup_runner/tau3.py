"""Harbor agent for tau3-bench tasks: `--agent context_cup_runner.tau3:Tau3Agent`."""

from __future__ import annotations

import random

from harbor.environments.base import BaseEnvironment

from .host import CourseAgent

DEFAULT_SEED = 300


class Tau3Agent(CourseAgent):
    benchmark = "tau3"

    def environment_settings(self, environment: BaseEnvironment) -> dict[str, str]:
        if len(self.mcp_servers) != 1:
            raise ValueError(
                f"tau3 tasks expose exactly one MCP server, got {len(self.mcp_servers)}"
            )
        server = self.mcp_servers[0]
        if server.transport != "streamable-http" or not server.url:
            raise ValueError(
                "the tau3 runtime must be a streamable-http MCP server with a url"
            )
        settings = {
            "CC_TAU3_MCP_URL": server.url,
            "CC_TAU3_SEED": str(self.trial_seed()),
        }
        max_errors = self._get_env("CC_TAU3_MAX_ERRORS")
        if max_errors:
            settings["CC_TAU3_MAX_ERRORS"] = max_errors
        return settings

    def trial_seed(self) -> int:
        """Every attempt of a job shares one agent config, so the trial name
        (harbor appends a short unique suffix) is what tells attempts apart.
        Mixing it into the base seed gives each attempt its own simulated user
        instead of replaying one conversation."""
        base = self._get_env("CC_TAU3_SEED") or str(DEFAULT_SEED)
        trial_name = self.logs_dir.parent.name
        return random.Random(f"{base}:{trial_name}").randint(0, 1_000_000)
