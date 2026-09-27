"""The driver protocol (docs/protocol.md) as a library, shared by the runner
and the engines: the models of `input.json` and `output.json`, one adapter
per provider for native payloads, and a provider-neutral view of them."""

from .engine import EngineContext, run_engine
from .manifest import Manifest, read_manifest, read_pyproject
from .models import (
    PLACEHOLDER_KEY,
    PROTOCOL_VERSION,
    Dirs,
    DriverInfo,
    Payload,
    Provider,
    ProviderApi,
    ProviderClient,
    ProviderInfo,
    Target,
    TurnInput,
    TurnOutput,
    Wire,
)
from .providers import (
    Extracted,
    ProviderAdapter,
    Step,
    ToolCallRef,
    Utterance,
    adapter_for,
    function_schemas,
)
from .snapshot import load_snapshot, save_snapshot
from .view import Conversation, Message, Tool, ToolCall, view, write

__all__ = [
    "PLACEHOLDER_KEY",
    "PROTOCOL_VERSION",
    "Conversation",
    "Dirs",
    "DriverInfo",
    "EngineContext",
    "Extracted",
    "Manifest",
    "Message",
    "Payload",
    "Provider",
    "ProviderAdapter",
    "ProviderApi",
    "ProviderClient",
    "ProviderInfo",
    "Step",
    "Target",
    "Tool",
    "ToolCall",
    "ToolCallRef",
    "TurnInput",
    "TurnOutput",
    "Utterance",
    "Wire",
    "adapter_for",
    "function_schemas",
    "load_snapshot",
    "read_manifest",
    "read_pyproject",
    "run_engine",
    "save_snapshot",
    "view",
    "write",
]
