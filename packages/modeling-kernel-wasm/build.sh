#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CARGO_DIR="${CARGO_HOME:-$HOME/.cargo}"
export PATH="$CARGO_DIR/bin:$PATH"
cd "$SCRIPT_DIR"

if command -v rustup >/dev/null 2>&1; then
  if ! rustup target list --installed 2>/dev/null | grep -qx 'wasm32-unknown-unknown'; then
    rustup target add wasm32-unknown-unknown
  fi
fi

TARGET_DIR="${CARGO_TARGET_DIR:-$SCRIPT_DIR/target}"
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=/builder --remap-path-prefix=$CARGO_DIR=/cargo --remap-path-prefix=$REPO_ROOT=/workspace" \
  cargo build --target wasm32-unknown-unknown --release
mkdir -p pkg
WASM_SRC="$TARGET_DIR/wasm32-unknown-unknown/release/forgeax_modeling_kernel_wasm.wasm"
WASM_OUT="pkg/modeling_kernel.wasm"
cp "$WASM_SRC" "$WASM_OUT"

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-multivalue --enable-sign-ext \
    --enable-nontrapping-float-to-int \
    "$WASM_OUT" -o "$WASM_OUT"
fi

node "$SCRIPT_DIR/scripts/verify-current.mjs" --write-provenance
ls -lh "$WASM_OUT"
