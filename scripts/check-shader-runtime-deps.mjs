#!/usr/bin/env node
// AC-06 (b): @forgeax/engine-shader/package.json deps/peerDeps/devDeps must not
// list build-core. Plan §S-2 + feat-20260511-naga-rhi-wgpu-merge §D-P6.
//
// banned list (feat-20260511-naga-rhi-wgpu-merge w12 rewrite):
//   - @forgeax/engine-shader-compiler  (build-time WGSL compile core; cannot
//                                 reach runtime)
//   - @forgeax/engine-wgpu-wasm        (Rust crate + raw bindings; build-time
//                                 shader path only — @forgeax/engine-naga consumes
//                                 it for parse/validate/emit_reflection)
//   - @forgeax/engine-naga             (TS-only build-time shader shell)
import { readFileSync } from 'node:fs';
import process from 'node:process';

const banned = [
  '@forgeax/engine-shader-compiler',
  '@forgeax/engine-wgpu-wasm',
  '@forgeax/engine-naga',
];
const segments = ['dependencies', 'peerDependencies', 'devDependencies'];
const pkgPath = process.argv[2] ?? 'packages/shader/package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const hits = [];

for (const seg of segments) {
  const obj = pkg[seg];
  if (typeof obj !== 'object' || obj === null) continue;
  for (const name of Object.keys(obj)) if (banned.includes(name)) hits.push({ seg, name });
}

if (hits.length > 0) {
  process.stderr.write(`AC-06 (b) FAIL: ${pkgPath} runtime deps contain banned packages:\n`);
  for (const h of hits) process.stderr.write(`  ${h.seg}.${h.name}\n`);
  process.stderr.write(
    `[hint] @forgeax/engine-shader is a runtime registry; build-core packages (shader-compiler, wgpu-wasm, naga) must stay build-time only. Move the dep to packages/shader-compiler or remove it.\n`,
  );
  process.exit(1);
}
process.stdout.write(`AC-06 (b) OK: ${pkgPath} runtime deps clean\n`);
