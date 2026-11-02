#!/bin/bash
# Renders the mech-gt film (assets/show/cinematic.ts) on Dawn/lavapipe in parallel frame
# ranges, validates every frame and encodes an MP4.
# usage: scripts/film.sh <output.mp4> [processes] [WxH]   (PARALLEL=2 renders at a time)
# Needs the lavapipe ICD (VK_ICD_FILENAMES, LD_LIBRARY_PATH); heavy steps use `forgeax-heavy`.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
video=$(realpath -m "${1:?usage: film.sh <output.mp4> [processes] [WxH]}")
jobs=${2:-3}
size=${3:-1280x720}
heavy=$(command -v forgeax-heavy || true)
out=apps/modeling-show/mech-gt/artifacts/film
rm -rf "$out"
# Cooked Pack outputs, one process per Pack (cached across runs).
# One heavy job; at most two Pack cooks at a time (each can use up to 12 GB).
$heavy bash -c "ls apps/modeling-show/mech-gt/assets/*.pack.ts | grep -v show.pack |
  xargs -n1 -P 2 node --max-old-space-size=12000 apps/modeling-show/mech-gt/scripts/outputs.mts"
total=$(node -e "import('./apps/modeling-show/assets/show/cinematic.ts').then((m) => console.log(Math.round(m.FILM_SECONDS * m.FILM_FPS)))")
fps=$(node -e "import('./apps/modeling-show/assets/show/cinematic.ts').then((m) => console.log(m.FILM_FPS))")
# Ranges never mix subjects (each process loads only the subjects it shows): the car beat,
# then the transformation and robot split into `jobs` parts; at most PARALLEL at a time.
car=$(node -e "import('./apps/modeling-show/assets/show/cinematic.ts').then((m) => console.log(Math.round(m.FILM_SEGMENTS[0].seconds * m.FILM_FPS)))")
ranges=("0-$((car - 1))")
per=$(( (total - car + jobs - 1) / jobs ))
for ((i = 0; i < jobs; i++)); do
  a=$((car + i * per)); b=$((car + (i + 1) * per - 1)); (( b >= total )) && b=$((total - 1))
  ranges+=("$a-$b")
done
mkdir -p "$out"
render() {
  NODE_OPTIONS=--max-old-space-size=16000 LP_NUM_THREADS=${LP_NUM_THREADS:-10} FORGEAX_MECH_GT_RECORD=$out \
    FORGEAX_MECH_GT_FRAMES=$1 FORGEAX_MECH_GT_SIZE=$size \
    $heavy node node_modules/vitest/vitest.mjs run --project dawn apps/modeling-show/__tests__/mech-gt.record.dawn.test.ts \
    > "$out-$1.log" 2>&1 || { grep -h -E "AssertionError|Error:" "$out-$1.log" | head; return 1; }
}
export -f render
export out size heavy
printf '%s\n' "${ranges[@]}" | xargs -P "${PARALLEL:-2}" -I{} bash -c 'render {}'
mkdir -p "$(dirname "$video")"
ffmpeg -loglevel error -y -framerate "$fps" -i "$out/frame-%04d.png" \
  -vf "format=yuv420p" -c:v libx264 -preset slow -crf 26 -movflags +faststart "$video"
ls -la "$video"
