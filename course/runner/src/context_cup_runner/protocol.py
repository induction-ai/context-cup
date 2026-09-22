"""The turn protocol between the runner and a driver (docs/protocol.md,
version 2): provider-native payloads in, the provider's response out.
"""

from __future__ import annotations

import secrets
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .providers.base import Extracted, Payload, ProviderAdapter, ensure_json_dict

PROTOCOL_VERSION = 2
TURN_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


def new_turn_id(index: int) -> str:
    """`001_k3v9xq`: zero-padded index, then six random base36 characters."""
    if index < 1:
        raise ValueError("turn index starts at 1")
    suffix = "".join(secrets.choice(TURN_ID_ALPHABET) for _ in range(6))
    return f"{index:03d}_{suffix}"


# Mirrors PROVIDERS and WIRES in course/shared/src/provider.ts.
Provider = Literal["openai", "anthropic", "gemini"]
Wire = Literal["responses", "completions", "anthropic", "gemini"]


class Target(BaseModel):
    """What the suite asks for (CC_TARGET_JSON)."""

    model_config = ConfigDict(extra="allow")

    provider: Provider
    model: str
    reasoning_effort: str | None = None


ClientApi = Literal["responses", "messages", "generate_content"]


class ClientInfo(BaseModel):
    """Where and how the driver reaches the provider."""

    base_url: str
    api: ClientApi


class ProviderInfo(BaseModel):
    """The `provider` object in input.json. The persisted copy of input.json
    has `api_key` redacted once the turn is over."""

    name: Provider
    api_key: str
    client: ClientInfo


PROVIDER_CLIENTS: dict[Provider, ClientInfo] = {
    "openai": ClientInfo(base_url="https://api.openai.com/v1", api="responses"),
    "anthropic": ClientInfo(base_url="https://api.anthropic.com/v1", api="messages"),
    "gemini": ClientInfo(
        base_url="https://generativelanguage.googleapis.com/v1beta",
        api="generate_content",
    ),
}

# The env var the host agent forwards for each provider; the first present wins.
PROVIDER_KEY_VARS: dict[Provider, tuple[str, ...]] = {
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
}

REDACTED = "<redacted>"


class TargetSpec(BaseModel):
    """The `target` object in input.json: the provider travels separately."""

    model: str
    reasoning_effort: str | None = None


class Dirs(BaseModel):
    turn: str
    state: str
    workspace: str | None = None


class TurnInput(BaseModel):
    protocol: int = PROTOCOL_VERSION
    trial_id: str
    turn_id: str
    turn_index: int
    first: bool
    provider: ProviderInfo
    target: TargetSpec
    context_payload: Payload
    original_payload: Payload
    state: Any = None
    limits: dict[str, Any] = Field(default_factory=dict)
    dirs: Dirs


class Usage(BaseModel):
    input: int = 0
    cached_input: int = 0
    cache_write_input: int = 0
    output: int = 0
    reasoning_output: int = 0

    def add(self, other: Usage) -> None:
        self.input += other.input
        self.cached_input += other.cached_input
        self.cache_write_input += other.cache_write_input
        self.output += other.output
        self.reasoning_output += other.reasoning_output


class Call(BaseModel):
    model_config = ConfigDict(extra="allow")

    provider: Provider
    host: str = ""
    model: str
    wire: Wire
    purpose: str = "turn"
    usage: Usage = Field(default_factory=Usage)
    duration_ms: int | None = None
    service_tier: str | None = None


class DriverInfo(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str
    engine: str | None = None
    version: str | None = None


class TurnOutput(BaseModel):
    protocol: int = PROTOCOL_VERSION
    turn_id: str
    response: Payload
    context_payload: Payload | None = None
    state: Any = None
    calls: list[Call] = Field(default_factory=list)
    driver: DriverInfo | None = None

    @property
    def state_given(self) -> bool:
        """Whether the driver sent `state` at all (absent means unchanged)."""
        return "state" in self.model_fields_set


def validate_output(
    raw: dict[str, Any], turn_id: str, adapter: ProviderAdapter
) -> tuple[TurnOutput, Extracted]:
    """Parse output.json and enforce the rules a driver must follow."""
    output = TurnOutput.model_validate(raw)
    if output.protocol != PROTOCOL_VERSION:
        raise ValueError(f"unsupported protocol version {output.protocol}")
    if output.turn_id != turn_id:
        raise ValueError(f"output turn_id {output.turn_id!r} is not {turn_id!r}")
    ensure_json_dict(output.response, "response")
    if output.context_payload is not None:
        ensure_json_dict(output.context_payload, "context_payload")
    extracted = adapter.extract(output.response)
    if extracted.empty:
        raise ValueError("response has neither text nor tool calls")
    for call in extracted.tool_calls:
        if not call.name:
            raise ValueError(f"malformed tool call: {call!r}")
    return output, extracted
