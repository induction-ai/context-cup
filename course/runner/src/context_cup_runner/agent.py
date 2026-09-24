"""Harbor agents for a whole agent written as a script, one per benchmark:
`--agent context_cup_runner.agent:Tau3ScriptAgent` or
`--agent context_cup_runner.agent:ToolathlonScriptAgent`.

An agent package (`"kind": "agent"` with no `harbor_agent`) is set up exactly
as a turn-protocol driver is: its chain is uploaded, each setup.sh runs as
root, and the trial's proxy starts with the keys out of reach of `ccdriver`.
Then instead of the course's turn loop, the package's `agent.sh` runs once,
as `ccdriver`, and works the task itself. Each class passes its benchmark's
settings, so the benchmark is set up for the agent as the turn loop would set
it up: tau3's simulated user is seeded per trial, and Toolathlon's agent
prompt is handed over (see script_agent.py).
"""

from __future__ import annotations

from harbor.environments.base import BaseEnvironment

from .tau3 import Tau3Agent
from .toolathlon import ToolathlonAgent

SCRIPT_LOOP = "context_cup_runner.script_agent"


class Tau3ScriptAgent(Tau3Agent):
    loop_module = SCRIPT_LOOP

    @staticmethod
    def name() -> str:
        return "context-cup-agent"

    def environment_settings(self, environment: BaseEnvironment) -> dict[str, str]:
        return {
            **super().environment_settings(environment),
            "CC_MCP_SERVERS_JSON": self.mcp_servers_json(),
        }


class ToolathlonScriptAgent(ToolathlonAgent):
    loop_module = SCRIPT_LOOP

    @staticmethod
    def name() -> str:
        return "context-cup-agent"
