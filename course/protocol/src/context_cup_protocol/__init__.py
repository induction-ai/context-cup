"""The driver protocol (docs/protocol.md) as a library, shared by the runner
and the engines: the models of `input.json` and `output.json`, one adapter
per provider for native payloads, and a provider-neutral view of them."""

from .cache_bust import (
    CACHE_BUST_TOOL_PREFIX,
    CACHE_BUST_TOOL_RESULT,
    cache_bust_tool,
    cache_bust_tool_name,
)
from .engine import EngineContext, run_engine
from .manifest import Manifest, read_manifest, read_pyproject
from .models import (
    PLACEHOLDER_KEY,
    PROTOCOL_VERSION,
    PROVIDERS,
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
from .proxy import PROVIDER_API, proxy_base_url, route, trial_root
from .snapshot import load_snapshot, save_snapshot
from .view import Conversation, Message, Tool, ToolCall, view, write

__all__ = [
    "CACHE_BUST_TOOL_PREFIX",
    "CACHE_BUST_TOOL_RESULT",
    "PLACEHOLDER_KEY",
    "PROTOCOL_VERSION",
    "PROVIDERS",
    "PROVIDER_API",
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
    "cache_bust_tool",
    "cache_bust_tool_name",
    "function_schemas",
    "load_snapshot",
    "proxy_base_url",
    "read_manifest",
    "read_pyproject",
    "route",
    "run_engine",
    "save_snapshot",
    "trial_root",
    "view",
    "write",
]
