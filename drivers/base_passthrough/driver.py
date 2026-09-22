"""The baseline: no context management at all."""

from context_cup_engine import Payload, TurnContext


def run(ctx: TurnContext) -> Payload:
    return ctx.call(ctx.context_payload)
