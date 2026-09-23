#!/usr/bin/env bash
# One turn: run.sh <input.json> <output.json>
set -euo pipefail
exec "$CC_SELF_DIR/.venv/bin/python" -m context_cup_litellm --driver "$CC_DRIVER_DIR" --input "$1" --output "$2"
