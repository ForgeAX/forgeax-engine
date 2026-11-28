#!/usr/bin/env node
// Materializes the untracked forgeax_render_kernel_wasm_bg.wasm artifact between
// wasm/ and dist/, building via wasm-pack when absent and toolchain is available.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WASM_NAME = 'forgeax_render_kernel_wasm_bg.wasm';
const WASM_PATH = resolve(PKG_ROOT, 'wasm', WASM_NAME);
const DIST_PATH = resolve(PKG_ROOT, 'dist', WASM_NAME);

function copyTo(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

function hasWasmPack() {
  const probe = spawnSync('wasm-pack', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

if (existsSync(WASM_PATH)) {
  copyTo(WASM_PATH, DIST_PATH);
} else if (existsSync(DIST_PATH)) {
  copyTo(DIST_PATH, WASM_PATH);
} else if (hasWasmPack()) {
  execFileSync('bash', [resolve(PKG_ROOT, 'build-wasm.sh')], {
    cwd: PKG_ROOT,
    stdio: 'inherit',
  });
  if (existsSync(WASM_PATH)) copyTo(WASM_PATH, DIST_PATH);
}
