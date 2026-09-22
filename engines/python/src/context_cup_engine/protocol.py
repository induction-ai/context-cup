"""Pydantic models for the driver protocol, version 2 (docs/protocol.md)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

PROTOCOL_VERSION = 2

# Mirrors PROVIDERS and WIRES in course/shared/src/provider.ts.
Provider = Literal["openai", "anthropic", "gemini"]
Wire = Literal["responses", "completions", "anthropic", "gemini"]

# A provider request body or response object: JSON, shape owned by the provider.
Payload = dict[str, Any]


class Target(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str = Field(min_length=1)
    reasoning_effort: str | None = None


ProviderApi = Literal["responses", "messages", "generate_content"]


class ProviderClient(BaseModel):
    base_url: str = Field(min_length=1)
    api: ProviderApi


class ProviderInfo(BaseModel):
    """Everything needed to call the model: family, key, and where."""

    name: Provider
    api_key: str = Field(min_length=1)
    client: ProviderClient


class Dirs(BaseModel):
    turn: str
    state: str
    workspace: str | None = None


class TurnInput(BaseModel):
    model_config = ConfigDict(extra="allow")

    protocol: Literal[2] = 2
    trial_id: str
    turn_id: str
    turn_index: int
    first: bool
    provider: ProviderInfo
    target: Target
    context_payload: Payload
    original_payload: Payload
    state: JsonValue = None
    limits: dict[str, Any] = Field(default_factory=dict)
    dirs: Dirs


class Usage(BaseModel):
    input: int = 0
    cached_input: int = 0
    cache_write_input: int = 0
    output: int = 0
    reasoning_output: int = 0

    def add(self, other: Usage) -> Usage:
        return Usage(
            input=self.input + other.input,
            cached_input=self.cached_input + other.cached_input,
            cache_write_input=self.cache_write_input + other.cache_write_input,
            output=self.output + other.output,
            reasoning_output=self.reasoning_output + other.reasoning_output,
        )


class ModelCall(BaseModel):
    # The provider family the call is billed under. When the host is not a
    # known provider endpoint, the wire decides: an OpenAI-shaped call to a
    # gateway is still an OpenAI call.
    provider: Provider
    # The endpoint host the call went to.
    host: str = ""
    model: str = Field(min_length=1)
    wire: Wire
    purpose: str = "turn"
    usage: Usage | None = None
    duration_ms: int = 0
    service_tier: str | None = None
    status: int | None = None
    request_bytes: int = 0
    response_bytes: int = 0
    streamed: bool = False


class DriverInfo(BaseModel):
    name: str
    engine: str
    version: str | None = None


class TurnOutput(BaseModel):
    protocol: Literal[2] = 2
    turn_id: str
    response: Payload
    context_payload: Payload | None = None
    state: JsonValue = None
    calls: list[ModelCall] = Field(default_factory=list)
    driver: DriverInfo
