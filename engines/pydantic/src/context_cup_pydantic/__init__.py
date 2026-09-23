"""Pydantic AI engine: a driver's `run(ctx)` returns Pydantic AI (Harness)
capabilities, or a whole `Agent`, and the engine runs the turn with it."""

import os

# Before pydantic_ai is imported: its startup banner would land in stdout.txt.
os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")

from .engine import HISTORY, PydanticContext, finish

__all__ = ["HISTORY", "PydanticContext", "finish"]
