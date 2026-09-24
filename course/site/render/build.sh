#!/usr/bin/env bash
#
# Render build command for the site (buildCommand in render/render.yaml).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Only the site and the workspace packages it imports, so a dependency problem
# elsewhere in the workspace can't break a site deploy.
"$root/../../bin/render_pnpm" --filter "@context-cup/site..."

cd "$root"
pnpm build
