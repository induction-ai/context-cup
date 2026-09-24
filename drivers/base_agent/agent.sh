#!/usr/bin/env bash
# Once per trial, as ccdriver: work the task, then exit.
set -euo pipefail
exec "$CC_SELF_DIR/.venv/bin/python" "$CC_SELF_DIR/agent.py"
