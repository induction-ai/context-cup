#!/usr/bin/env bash
# Runs once per trial container, before any driver setup that extends this
# engine. Installs into a private venv on a uv-managed Python 3.12, so the
# engine never depends on, or disturbs, the task image's own Python.
set -euo pipefail
VENV="$CC_SELF_DIR/.venv"
PYTHON_VERSION="3.12"

if command -v uv >/dev/null 2>&1; then
  UV="$(command -v uv)"
else
  # Standalone: no runner provisioned uv for us (for example a local test).
  export UV_CACHE_DIR="${UV_CACHE_DIR:-$CC_SELF_DIR/.uv/cache}"
  export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$CC_SELF_DIR/.uv/python}"
  mkdir -p "$CC_SELF_DIR/.uv"
  curl -LsSf https://astral.sh/uv/install.sh \
    | env UV_INSTALL_DIR="$CC_SELF_DIR/.uv" UV_NO_MODIFY_PATH=1 sh >/dev/null
  UV="$CC_SELF_DIR/.uv/uv"
fi
"$UV" venv --quiet --python "$PYTHON_VERSION" "$VENV"
"$UV" pip install --quiet --python "$VENV/bin/python" "$CC_SELF_DIR"
