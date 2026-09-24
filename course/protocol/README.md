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

- `load_snapshot` and `save_snapshot`: an engine's own bookkeeping in
  `dirs.state`, kept per accepted turn so a discarded attempt never leaks into
  its retry.

Engines and drivers may import this package and nothing else from `course/`.

## TypeScript

The same package is `@context-cup/protocol`, the protocol for the TypeScript
engines, in `src/*.ts` beside the Python:

- `models.ts`: the `input.json` and `output.json` types, with a parser for
  `input.json`.
- `view.ts`: `view` and `write`, the twin of `view.py`. Both read a payload
  the same way; `tests/test_protocol_contract.py` checks it on the shared
  fixtures in `tests/view_fixtures.json`.
- `engine.ts`: `runEngine`, the turn mechanics of `run_engine`.
- `snapshot.ts`: `loadSnapshot` and `saveSnapshot`, as in `snapshot.py`.
- `bundle.ts`: bundles an engine's entry point and a driver's `driver.ts`
  with their npm packages into one file that `node` runs in a trial
  container. An engine's `build.sh` calls it on the host.

Tests: `uv run pytest course/protocol` and `bin/test --project protocol`.
