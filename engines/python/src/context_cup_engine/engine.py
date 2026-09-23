"""What a driver's `run(ctx)` receives."""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any

from context_cup_protocol import (
    Conversation,
    Dirs,
    Payload,
    ProviderInfo,
    Target,
    TurnInput,
    view,
    write,
)


@dataclass
class PythonContext:
    """The turn's input, read only, plus the two things a driver may change:
    `context_payload` (the working copy of the conversation) and `state`."""

    turn: TurnInput
    config: dict[str, Any] = field(default_factory=dict)
    context_payload: Payload = field(init=False)
    state: Any = field(init=False)

    def __post_init__(self) -> None:
        self.context_payload = copy.deepcopy(self.turn.context_payload)
        self.state = copy.deepcopy(self.turn.state)

    @property
    def first(self) -> bool:
        return self.turn.first

    @property
    def provider(self) -> ProviderInfo:
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
    def turn_id(self) -> str:
        return self.turn.turn_id

    def view(self) -> Conversation:
        """`context_payload` as a provider-neutral conversation."""
        return view(self.provider.name, self.context_payload)

    def write(self, conversation: Conversation) -> None:
        """Apply the conversation's edits to `context_payload`."""
        self.context_payload = write(
            self.provider.name, self.context_payload, conversation
        )
