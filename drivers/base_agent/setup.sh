#!/usr/bin/env bash
# Once per trial container, as root: a venv on a uv-managed Python 3.12 with
# LiteLLM (pinned as engines/litellm pins it) and the MCP client.
set -euo pipefail
uv venv --quiet --python 3.12 "$CC_SELF_DIR/.venv"
uv pip install --quiet --python "$CC_SELF_DIR/.venv/bin/python" \
  "litellm==1.83.0" "mcp>=1.25,<2"
