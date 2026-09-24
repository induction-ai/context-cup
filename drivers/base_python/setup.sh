#!/usr/bin/env bash
# One client per provider this driver declares, into the engine's venv. The
# runner points them at the proxy with placeholder keys.
set -euo pipefail
uv pip install --quiet --python "${CC_CHAIN%%:*}/.venv/bin/python" openai anthropic httpx
