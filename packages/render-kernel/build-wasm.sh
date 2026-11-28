#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$DIR/wasm"
mkdir -p "$OUT_DIR"

export CARGO_ENCODED_RUSTFLAGS
CARGO_ENCODED_RUSTFLAGS="$(node "$DIR/../../scripts/lib/rust-build-paths.mjs" "$DIR/../..")"
wasm-pack build "$DIR/rust/crates/kernel-wasm" \
  --target web \
  --release \
  --out-dir "$OUT_DIR" \
  --out-name forgeax_render_kernel_wasm \
  -- --locked

rm -f "$OUT_DIR/.gitignore" "$OUT_DIR/package.json" "$OUT_DIR/README.md"
node -e '
const fs = require("node:fs");
const p = process.argv[1];
const src = fs.readFileSync(p, "utf8");
const next = src.replace(
  "module_or_path = new URL(\x27forgeax_render_kernel_wasm_bg.wasm\x27, import.meta.url);",
  "const defaultWasmRel = \x27./forgeax_render_kernel_wasm_bg.wasm\x27;\n        module_or_path = new URL(defaultWasmRel, import.meta.url);"
);
fs.writeFileSync(p, next);
' "$OUT_DIR/forgeax_render_kernel_wasm.js"
echo "[render-kernel] Built WASM artifact at $OUT_DIR"
ls -lh "$OUT_DIR"/forgeax_render_kernel_wasm*
