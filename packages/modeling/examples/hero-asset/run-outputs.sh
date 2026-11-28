#!/usr/bin/env bash
# Derive the three output profiles (desktop-hero, mobile-hero, mobile-prop) from the exact blaster with deliverAsset,
# write outputs.json, OBJs and pictures into $GALLERY_OUT (slow: the fine desktop mesh and the mobile-prop size sweep).
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/bin:$PATH"
export GALLERY_OUT="${GALLERY_OUT:-${TMPDIR:-/tmp}/forgeax-fable-outputs-1}"
RUN=(forgeax-heavy --low node --import ./examples/gallery/register-entry.mjs --experimental-strip-types)
"${RUN[@]}" examples/hero-asset/outputs.ts
