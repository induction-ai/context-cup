"""base_passthrough: no context management at all, the baseline every other
driver is measured against. The Python engine's lane in its smallest form:
copy this to write a driver that works on the provider's native payload.
See engines/python/README.md for everything `ctx` holds."""

from context_cup_engine import PythonContext
from openai import OpenAI  # installed by this driver's setup.sh


def run(ctx: PythonContext):
    # `ctx.context_payload` is the full OpenAI Responses request the course
    # built: instructions, every input item so far (reasoning items
    # included), the tools, the target model and its reasoning effort. A
    # strategy would edit it here; the baseline sends it as it is.
    #
    # OpenAI() needs no configuration: the runner set OPENAI_BASE_URL to this
    # trial's prefix on the trial's proxy and OPENAI_API_KEY to a placeholder.
    # The proxy adds the real key and records the call's tokens and cost.
    #
    # Return the SDK's response object as it is: the engine writes the fields
    # OpenAI sent, and the course appends the reply and the tool results to
    # `context_payload` for next turn.
    return OpenAI().responses.create(**ctx.context_payload)
