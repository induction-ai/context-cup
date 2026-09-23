# context-cup-protocol

The driver protocol (`docs/protocol.md`) as a Python library, shared by the
runner and the engines so both sides of `input.json` and `output.json` run
the same code:

- `TurnInput`, `TurnOutput`, and the other models of the two files.
- `adapter_for(provider)`: build, read, and extend a provider-native payload.
- `view(provider, payload)` and `write(provider, payload, conversation)`: a
  provider-neutral conversation over a native payload, and the way back.
  Unedited parts come back byte for byte; reasoning, thinking, and other
  provider-only material rides along as `opaque`.

Engines and drivers may import this package and nothing else from `course/`.
