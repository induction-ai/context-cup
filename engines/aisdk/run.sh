#!/usr/bin/env bash
# One turn: run.sh <input.json> <output.json>
set -euo pipefail
exec "$CC_NODE" --enable-source-maps "$CC_DRIVER_DIR/bundle/turn.mjs" \
  --driver "$CC_DRIVER_DIR" --input "$1" --output "$2"
