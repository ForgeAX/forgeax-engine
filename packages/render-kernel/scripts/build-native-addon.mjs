#!/usr/bin/env node
// Opt-in build of the RenderKernel Node-API addon (`rust/crates/kernel-napi`).
// Never part of `pnpm build:engine`: needs a Rust toolchain + pinned wgpu source,
// and outputs gitignored `native/forgeax-render-kernel.<platform>-<arch>.node`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'rust', 'crates', 'kernel-napi');
const target = process.env.CARGO_TARGET_DIR ?? join(root, 'rust', 'target');
const cargoArgs = ['build', '--release'];
if (existsSync(join(crate, 'Cargo.lock'))) {
  cargoArgs.push('--locked');
}
const built = spawnSync('cargo', cargoArgs, {
  cwd: crate,
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: target },
});
if (built.status !== 0) {
  console.error('[render-kernel] cargo build failed; native render thread addon unavailable');
  process.exit(built.status ?? 1);
}
const library = {
  linux: 'libforgeax_render_kernel_napi.so',
  darwin: 'libforgeax_render_kernel_napi.dylib',
  win32: 'forgeax_render_kernel_napi.dll',
}[process.platform];
if (library === undefined) {
  console.error(`[render-kernel] unsupported platform ${process.platform}`);
  process.exit(1);
}
const out = join(root, 'native');
mkdirSync(out, { recursive: true });
const addon = join(out, `forgeax-render-kernel.${process.platform}-${process.arch}.node`);
copyFileSync(join(target, 'release', library), addon);
console.log(`[render-kernel] ${addon}`);
