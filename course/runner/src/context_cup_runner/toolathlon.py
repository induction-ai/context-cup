"""Harbor agent for Toolathlon tasks: `--agent context_cup_runner.toolathlon:ToolathlonAgent`."""

from __future__ import annotations

from harbor.environments.base import BaseEnvironment

from .host import CourseAgent


class ToolathlonAgent(CourseAgent):
    benchmark = "toolathlon"

    def environment_settings(self, environment: BaseEnvironment) -> dict[str, str]:
        settings = {"CC_MCP_SERVERS_JSON": self.mcp_servers_json()}
        for key in (
            "CC_TOOLATHLON_BUNDLE",
            "CC_WORKSPACE_DIR",
            "CC_MAX_UNANSWERED_CALLS",
        ):
            value = self._get_env(key)
            if value:
                settings[key] = value
        return settings
