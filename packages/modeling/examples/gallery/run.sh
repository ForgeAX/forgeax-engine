#!/usr/bin/env bash
# Regenerates the whole gallery into GALLERY_OUT (default: _scratch/viz-out/gallery-1/) and stamps it.
# Run from a COMMITTED clean tree; stamp.ts exits non-zero when the tree is dirty.
# Every merged visible feature adds a row: add it to a rows-*.ts script (or a new one plus PART_ORDER in stamp.ts).
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/bin:$PATH"
out="${GALLERY_OUT:-$(cd ../../_scratch 2>/dev/null && pwd)/viz-out/gallery-1}"
export GALLERY_OUT="$out"
rm -rf "$out/.parts" "$out/.raw"
mkdir -p "$out"
run() { forgeax-heavy --low node --import ./examples/gallery/register-entry.mjs --experimental-strip-types "$@"; }
GALLERY_NO_MERGE=1 run examples/gallery/before-merge.ts
run examples/gallery/rows-modes.ts
run examples/gallery/rows-iso.ts
run examples/gallery/rows-ssi.ts
run examples/gallery/rows-s2.ts
run examples/gallery/rows-extras.ts
run examples/gallery/rows-reruns.ts
run examples/gallery/stamp.ts
