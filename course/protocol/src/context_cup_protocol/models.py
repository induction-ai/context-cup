"""The files a turn exchanges (docs/protocol.md): `input.json`, written by
the runner and read by an engine, and `output.json`, the reverse."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

PROTOCOL_VERSION = 2

# Mirrors PROVIDERS and WIRES in course/shared/src/provider.ts.
Provider = Literal["openai", "anthropic", "gemini"]
Wire = Literal["responses", "completions", "anthropic", "gemini"]
ProviderApi = Literal["responses", "messages", "generate_content"]

PLACEHOLDER_KEY = "cc-proxy"
"""The only key a trial container holds. Every call goes through the run's
proxy, which injects the real one."""

Payload = dict[str, Any]
"""A provider request body or response object, as JSON."""


class Target(BaseModel):
    """The `target` object: the model the suite runs against."""

    model_config = ConfigDict(extra="allow")

    model: str = Field(min_length=1)
    reasoning_effort: str | None = None


class ProviderClient(BaseModel):
    """Where and how to reach the provider: a base URL into the proxy."""

    base_url: str = Field(min_length=1)
    api: ProviderApi


class ProviderInfo(BaseModel):
    """The `provider` object: family, placeholder key, and client."""

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
    model_config = ConfigDict(extra="allow")

    name: str
    engine: str | None = None
    version: str | None = None


class TurnOutput(BaseModel):
    protocol: Literal[2] = 2
    turn_id: str
    response: Payload
    """The provider's response object for the turn, verbatim."""
    context_payload: Payload | None = None
    state: JsonValue = None
    driver: DriverInfo | None = None

    @property
    def state_given(self) -> bool:
        """Whether the driver sent `state` at all (absent means unchanged)."""
        return "state" in self.model_fields_set
