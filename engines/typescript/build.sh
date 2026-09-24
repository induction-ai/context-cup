#!/usr/bin/env bash
# On the host, once per suite run, before any trial: bundle this engine's
# entry point and the driver's driver.ts, with every npm package either
# imports, into $CC_DRIVER_DIR/bundle/turn.mjs. Trial containers have the
# runner's node but no package manager, so nothing is installed there.
set -euo pipefail
exec "$CC_SELF_DIR/node_modules/.bin/tsx" \
  "$CC_SELF_DIR/node_modules/@context-cup/protocol/src/bundle.ts" \
  --main "$CC_SELF_DIR/src/main.ts" --driver "$CC_DRIVER_DIR"
