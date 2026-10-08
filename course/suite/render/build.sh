#!/usr/bin/env bash
#
# Render build command for the drivers-sync cron (render/render.yaml).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Only course/suite and the workspace packages it imports: bin/drivers reads
# drivers/ and engines/ from the checkout but never installs them.
"$root/../../bin/render_pnpm" --filter "@context-cup/suite..."
