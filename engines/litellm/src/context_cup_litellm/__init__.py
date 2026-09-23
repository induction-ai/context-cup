"""LiteLLM engine: a driver gets `ctx.llm`, a litellm handle preconfigured for
the run, calls it as it likes, and returns the litellm response of its turn."""

import os

# Before litellm is imported: use the bundled model price map rather than
# fetching one over the network at import time.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

from .engine import LLM, LitellmContext, chat_messages, chat_tools, finish

__all__ = ["LLM", "LitellmContext", "chat_messages", "chat_tools", "finish"]
