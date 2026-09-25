"""The runner's side of the turn protocol. The models themselves live in
`context_cup_protocol` (course/protocol); this module adds what only the
runner needs: turn ids, the run target, proxy addressing, output checks."""

from __future__ import annotations

import secrets
from typing import Any

from pydantic import BaseModel, ConfigDict

from context_cup_protocol import (
    PLACEHOLDER_KEY,
    PROTOCOL_VERSION,
    Dirs,
    DriverInfo,
    Extracted,
    Payload,
    Provider,
    ProviderAdapter,
    ProviderApi,
    ProviderClient,
    ProviderInfo,
    TurnInput,
    TurnOutput,
    Wire,
)
from context_cup_protocol import Target as TargetSpec
from context_cup_protocol.providers.base import ensure_json_dict

__all__ = [
    "PLACEHOLDER_KEY",
    "PROTOCOL_VERSION",
    "Dirs",
    "DriverInfo",
    "Payload",
    "Provider",
    "ProviderClient",
    "ProviderInfo",
    "Target",
    "TargetSpec",
    "TurnInput",
    "TurnOutput",
    "Wire",
    "new_turn_id",
    "proxy_client",
    "proxy_env",
    "validate_output",
]

TURN_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


def new_turn_id(index: int) -> str:
    """`001_k3v9xq`: zero-padded index, then six random base36 characters."""
    if index < 1:
        raise ValueError("turn index starts at 1")
    suffix = "".join(secrets.choice(TURN_ID_ALPHABET) for _ in range(6))
    return f"{index:03d}_{suffix}"


class Target(BaseModel):
    """What the suite asks for (CC_TARGET_JSON): the input's target plus the
    provider, which input.json carries separately."""

    model_config = ConfigDict(extra="allow")

    provider: Provider
    model: str
    reasoning_effort: str | None = None


# Where each provider's API lives behind the proxy: `<proxy>/t/<trial>/<provider><suffix>`.
PROVIDER_API: dict[Provider, tuple[str, ProviderApi]] = {
    "openai": ("/v1", "responses"),
    "anthropic": ("/v1", "messages"),
    "gemini": ("/v1beta", "generate_content"),
}


def proxy_base_url(proxy_url: str, trial_id: str, provider: Provider) -> str:
    suffix, _ = PROVIDER_API[provider]
    return f"{proxy_url.rstrip('/')}/t/{trial_id}/{provider}{suffix}"


def proxy_client(proxy_url: str, trial_id: str, provider: Provider) -> ProviderClient:
    return ProviderClient(
        base_url=proxy_base_url(proxy_url, trial_id, provider),
        api=PROVIDER_API[provider][1],
    )


def proxy_env(proxy_url: str, trial_id: str) -> dict[str, str]:
    """What a driver process needs so any SDK it uses talks to the proxy:
    base URLs for every provider and placeholder keys, since SDKs refuse to
    start without one. No real key exists in the container."""
    # SDK conventions differ: OpenAI's base URL includes /v1, while the
    # Anthropic and Google SDKs append their own version path.
    root = f"{proxy_url.rstrip('/')}/t/{trial_id}"
    return {
        "OPENAI_BASE_URL": proxy_base_url(proxy_url, trial_id, "openai"),
        "ANTHROPIC_BASE_URL": f"{root}/anthropic",
        "GOOGLE_GEMINI_BASE_URL": f"{root}/gemini",
        "GEMINI_API_BASE_URL": f"{root}/gemini",
        "OPENAI_API_KEY": PLACEHOLDER_KEY,
        "ANTHROPIC_API_KEY": PLACEHOLDER_KEY,
        "GEMINI_API_KEY": PLACEHOLDER_KEY,
        "GOOGLE_API_KEY": PLACEHOLDER_KEY,
    }


class EmptyResponse(ValueError):
    """A well-formed response with neither text nor tool calls: nothing the
    environment can act on. Its attempt is discarded and re-asked."""


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
        raise EmptyResponse("response has neither text nor tool calls")
    for call in extracted.tool_calls:
        if not call.name:
            raise ValueError(f"malformed tool call: {call!r}")
    return output, extracted
