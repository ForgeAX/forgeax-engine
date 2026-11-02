#!/bin/bash
# Cron entry of the interactive-page runner (Modeling Studio ops/show-rebuild.md): refresh
# the Show app and its scripts from integration/modeling, then run one rebuild cycle. The
# Engine packages move with the runner's own Engine refresh (show-rebuild.mjs).
# A running cycle does not block the next one: the cycle takes a free lane lock itself (a second
# big build never starts; the small lane can run beside the big one). The Show app is refreshed
# here only while no cycle runs; a running cycle refreshes it itself before each build.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[ -e "$HOME/.config/forgeax/show-rebuild.pause" ] && exit 0
if ! pgrep -f 'apps/modeling-show/scripts/show-rebuild.mjs' > /dev/null; then
  git fetch -q origin integration/modeling
  git checkout -q origin/integration/modeling -- apps/modeling-show
fi
exec node apps/modeling-show/scripts/show-rebuild.mjs
