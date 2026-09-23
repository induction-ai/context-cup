"""Pydantic models for the driver protocol, version 2 (docs/protocol.md)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

PROTOCOL_VERSION = 2

# Mirrors PROVIDERS in course/shared/src/provider.ts.
Provider = Literal["openai", "anthropic", "gemini"]

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
    driver: DriverInfo
