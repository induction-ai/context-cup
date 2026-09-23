"""Provider-native payloads: one adapter per provider (docs/protocol.md,
"Payloads"). The loop never normalises a conversation; it asks the adapter
to build the first request body, to read a response, and to append the
response and tool results in the provider's own format.
"""

from __future__ import annotations

from .base import (
    Extracted,
    Payload,
    ProviderAdapter,
    Step,
    ToolCallRef,
    Utterance,
    function_schemas,
)
from .registry import adapter_for

__all__ = [
    "Extracted",
    "Payload",
    "ProviderAdapter",
    "Step",
    "ToolCallRef",
    "Utterance",
    "adapter_for",
    "function_schemas",
]
