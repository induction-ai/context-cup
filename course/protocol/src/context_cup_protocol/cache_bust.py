"""The cache-bust tool: one tool per trial, named after the trial, that the
model is told never to call.

Providers cache prompts by prefix, and the tool list opens the prompt. Two
trials of the same task would otherwise share a cached prefix (the system
prompt, the tools, the opening turn), so one trial's calls would be
discounted by another's, and a trial's cost would depend on what ran beside
or before it. A tool whose name differs per trial puts a difference at the
very front of every request, so each trial pays for its own prefix once and
caches only against itself. The course answers a call to it itself; no
environment ever sees one.

The name is `cache_bust_` and the trial id, kept to the characters every
provider accepts in a tool name; a trial id too long for the 64-character
cap is replaced by a digest of itself.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

CACHE_BUST_TOOL_PREFIX = "cache_bust_"
CACHE_BUST_TOOL_DESCRIPTION = "Never call this tool."
CACHE_BUST_TOOL_RESULT = json.dumps({"success": True})
MAX_TOOL_NAME_LENGTH = 64
"""OpenAI's and Anthropic's cap on a function name; Gemini's is the same."""
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")


def cache_bust_tool_name(trial_id: str) -> str:
    nonce = _UNSAFE.sub("_", trial_id)
    if len(CACHE_BUST_TOOL_PREFIX) + len(nonce) > MAX_TOOL_NAME_LENGTH:
        nonce = hashlib.sha256(trial_id.encode("utf-8")).hexdigest()[:16]
    return f"{CACHE_BUST_TOOL_PREFIX}{nonce}"


def cache_bust_tool(trial_id: str) -> dict[str, Any]:
    """The trial's cache-bust tool as the environments describe tools: an
    OpenAI function schema, which each provider adapter converts."""
    return {
        "type": "function",
        "function": {
            "name": cache_bust_tool_name(trial_id),
            "description": CACHE_BUST_TOOL_DESCRIPTION,
            "parameters": {"type": "object", "properties": {}},
        },
    }
