#!/bin/bash
# One-command showcase recording: web build -> recording -> 720p MP4.
# usage: scripts/rebuild.sh <output.mp4> [segment:frames,...]
#   FORGEAX_BROWSER_BACKEND  recording backend (default software)
#   MECH_GT_SKIP_BUILD=1     record the current sources without the production build check
# Heavy steps run through `forgeax-heavy` when it exists.
set -euo pipefail
cd "$(dirname "$0")/.."
video=$(realpath -m "${1:?usage: rebuild.sh <output.mp4> [segment:frames,...]}")
steps=${2:-0:24,1:60,2:24,3:16,4:16}
heavy=$(command -v forgeax-heavy || true)
if [ "${MECH_GT_SKIP_BUILD:-}" != 1 ]; then
  rm -rf dist
  $heavy ../node_modules/.bin/forgeax project build --json > artifacts-build.log 2>&1 || { tail -c 2000 artifacts-build.log; exit 1; }
fi
out=artifacts/recording
rm -rf "$out"
FORGEAX_SHOW_OUT=$out FORGEAX_SHOW_STEPS=$steps FORGEAX_BROWSER_BACKEND=${FORGEAX_BROWSER_BACKEND:-software} \
  $heavy node scripts/record.mjs
mkdir -p "$(dirname "$video")"
ffmpeg -loglevel error -y -framerate 8 -pattern_type glob -i "$out/frame-*.png" \
  -vf "scale=1280:-2,format=yuv420p" -c:v libx264 -preset slow -crf 30 -movflags +faststart "$video"
ls -la "$video"
