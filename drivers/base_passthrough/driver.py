"""The baseline: no context management at all."""

from context_cup_engine import PythonContext
from openai import OpenAI


def run(ctx: PythonContext):
    return OpenAI().responses.create(**ctx.context_payload)
