#!/usr/bin/env bash
# The OpenAI SDK, into the engine's venv. The runner points it at the proxy
# (OPENAI_BASE_URL and a placeholder OPENAI_API_KEY).
set -euo pipefail
uv pip install --quiet --python "${CC_CHAIN%%:*}/.venv/bin/python" openai
