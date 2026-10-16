#!/usr/bin/env node
// Opt-in build of the Node-API addon (`node/`). Never part of `pnpm build:engine`: it needs
// a Rust toolchain and the pinned wgpu source, and its output (`native/*.node`) is
// gitignored so the repository keeps no committed binaries.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'node');
const target = process.env.CARGO_TARGET_DIR ?? join(crate, 'target');
const built = spawnSync('cargo', ['build', '--release', '--locked'], {
  cwd: crate,
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: target },
});
if (built.status !== 0) {
  console.error('[rhi-wgpu-native] cargo build failed; the addon stays unavailable');
  process.exit(built.status ?? 1);
}
const library = {
  linux: 'libforgeax_rhi_wgpu_native_node.so',
  darwin: 'libforgeax_rhi_wgpu_native_node.dylib',
  win32: 'forgeax_rhi_wgpu_native_node.dll',
}[process.platform];
if (library === undefined) {
  console.error(`[rhi-wgpu-native] unsupported platform ${process.platform}`);
  process.exit(1);
}
const out = join(root, 'native');
mkdirSync(out, { recursive: true });
const addon = join(out, `forgeax-rhi-wgpu-native.${process.platform}-${process.arch}.node`);
copyFileSync(join(target, 'release', library), addon);
console.log(`[rhi-wgpu-native] ${addon}`);
