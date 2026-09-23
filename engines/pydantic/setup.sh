#!/usr/bin/env bash
# Once per trial container: a private venv on a uv-managed Python 3.12 with the
# shared protocol library (from the runner's upload), Pydantic AI, the harness,
# and this engine. A driver that needs more installs it into this venv.
set -euo pipefail
PROTOCOL_DIR="${CC_PROTOCOL_DIR:-$CC_SELF_DIR/../../course/protocol}"
uv venv --quiet --python 3.12 "$CC_SELF_DIR/.venv"
uv pip install --quiet --no-sources --python "$CC_SELF_DIR/.venv/bin/python" \
  "$PROTOCOL_DIR" "$CC_SELF_DIR"
