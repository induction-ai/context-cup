"""base_pydantic: clip any tool result larger than `config.max_bytes` before
it reaches the model. base_python, on Pydantic AI: copy this to write a
strategy as a Pydantic AI `Agent`, with your own capabilities (a history
processor here, or Pydantic AI Harness strategies), instructions, or model
settings. The engine connects the agent to the target through the trial's
proxy, hands it the course's tools, and keeps its history. See
engines/pydantic/README.md for everything `ctx` holds."""

from pydantic_ai import Agent
from pydantic_ai.capabilities import ProcessHistory
from pydantic_ai.messages import ModelMessage, ModelRequest, ToolReturnPart

from context_cup_pydantic import PydanticContext

MARKER = "\n\n[truncated by base_pydantic: {dropped} bytes removed]"
MARKER_PREFIX = "\n\n[truncated by base_pydantic:"


def clip(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes or MARKER_PREFIX in text:
        return text
    kept = raw[:max_bytes].decode("utf-8", errors="ignore")
    return kept + MARKER.format(dropped=len(raw) - max_bytes)


def run(ctx: PydanticContext) -> Agent:
    # Tunables live in package.json's contextCup.config, so a variant is a
    # manifest edit.
    max_bytes = int(ctx.config.get("max_bytes", 100_000))

    def clip_tool_results(messages: list[ModelMessage]) -> list[ModelMessage]:
        # The agent's whole history, before every model call. Tool results
        # are `ToolReturnPart`s in its requests.
        for message in messages:
            if not isinstance(message, ModelRequest):
                continue
            for part in message.parts:
                if isinstance(part, ToolReturnPart) and isinstance(part.content, str):
                    part.content = clip(part.content, max_bytes)
        return messages

    # No model and no instructions of its own: the engine gives the agent the
    # target and the course's system text, and adds the course's tools.
    return Agent(capabilities=[ProcessHistory(clip_tool_results)])
