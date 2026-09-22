"""What a driver's `run(ctx)` receives."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import client
from .protocol import (
    Dirs,
    ModelCall,
    Payload,
    Provider,
    ProviderInfo,
    Target,
    TurnInput,
)
from .recorder import Recorder


@dataclass
class TurnContext:
    """The parsed input plus the two things a driver needs to do: call a
    model and record what it did."""

    turn: TurnInput
    config: dict[str, Any]
    recorder: Recorder
    context_payload: Payload
    state: Any

    # -- input, read only -------------------------------------------------

    @property
    def first(self) -> bool:
        return self.turn.first

    @property
    def provider(self) -> Provider:
        """The provider family name; `ctx.provider_info` has key and client."""
        return self.turn.provider.name

    @property
    def provider_info(self) -> ProviderInfo:
        return self.turn.provider

    @property
    def target(self) -> Target:
        return self.turn.target

    @property
    def original_payload(self) -> Payload:
        return self.turn.original_payload

    @property
    def dirs(self) -> Dirs:
        return self.turn.dirs

    @property
    def state_dir(self) -> Path:
        return Path(self.turn.dirs.state)

    @property
    def turn_id(self) -> str:
        return self.turn.turn_id

    # -- doing things -----------------------------------------------------

    def call(
        self,
        payload: Payload,
        *,
        purpose: str = "turn",
        provider: ProviderInfo | None = None,
    ) -> Payload:
        """POST a native request body to the provider and return its response
        object. `purpose` labels the call in `output.json`."""
        self.recorder.purpose = purpose
        try:
            return client.call(provider or self.provider_info, payload)
        finally:
            self.recorder.purpose = "turn"

    def calls(self) -> list[ModelCall]:
        return list(self.recorder.calls)
