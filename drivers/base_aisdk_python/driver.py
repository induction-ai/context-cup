"""base_aisdk_python: clip any tool result larger than `config.max_bytes`
before it reaches the model. base_python, on the AI SDK for Python: copy this
to write one strategy for OpenAI and Anthropic over AI SDK messages: edit
`ctx.context_messages`, call `ctx.llm.generate()`, return its message.
See engines/aisdk_python/README.md for everything `ctx` holds."""

from ai.types.messages import Message, ToolResultPart

from context_cup_aisdk import AisdkContext

MARKER = "\n\n[truncated by base_aisdk_python: {dropped} bytes removed]"
MARKER_PREFIX = "\n\n[truncated by base_aisdk_python:"


def clip(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    # Clipped edits persist in context_messages, so a result clipped on an
    # earlier turn comes back with its marker; leave it as it is.
    if len(raw) <= max_bytes or MARKER_PREFIX in text:
        return text
    kept = raw[:max_bytes].decode("utf-8", errors="ignore")
    return kept + MARKER.format(dropped=len(raw) - max_bytes)


def clipped(part: ToolResultPart, max_bytes: int) -> ToolResultPart:
    # A part is immutable: a clipped result is a new part in the old one's
    # place.
    if not isinstance(part.result, str):
        return part
    return part.model_copy(update={"result": clip(part.result, max_bytes)})


def run(ctx: AisdkContext) -> Message:
    # Tunables live in pyproject.toml's [tool.context-cup.config], so a variant
    # is a manifest edit.
    max_bytes = int(ctx.config.get("max_bytes", 100_000))
    # `ctx.context_messages` is AI SDK messages: turn one, the whole
    # conversation; after that, last turn's list as this driver left it plus
    # the model's reply and the new tool results or user text. Tool results
    # are `ToolResultPart`s of `tool` messages. The clip persists: next turn
    # starts from the clipped list.
    for message in ctx.context_messages:
        if message.role == "tool":
            message.parts = [
                clipped(part, max_bytes) if isinstance(part, ToolResultPart) else part
                for part in message.parts
            ]
    # With no arguments, ctx.llm sends ctx.context_messages and ctx.tools to
    # the target through the trial's proxy. The engine emits the raw provider
    # body behind this message as the turn's answer.
    return ctx.llm.generate()
