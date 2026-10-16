#!/usr/bin/env node
// AC-06 (c): @forgeax/engine-shader/src/**/*.ts must not import build-core. Plan
// §S-2 + feat-20260511-naga-rhi-wgpu-merge §D-P6.
//
// banned import set (feat-20260511-naga-rhi-wgpu-merge w12 rewrite):
//   - @forgeax/engine-shader-compiler  (build-time WGSL compile core)
//   - @forgeax/engine-wgpu-wasm        (Rust crate + raw bindings; build-time
//                                 shader path only)
//   - @forgeax/engine-naga             (TS-only build-time shader shell)
//   - bare `naga` / `naga-wasm` symbols (covers any unrelated rust-named
//                                         shim resurfacing in TS layer)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.argv[2] ?? 'packages/shader/src';
const pat =
  /(?:import\s+[^'"`]*from\s*|import\s*\(|require\s*\()\s*['"](@forgeax\/engine-shader-compiler|@forgeax\/engine-wgpu-wasm|@forgeax\/engine-naga|@forgeax\/shader-compiler|@forgeax\/wgpu-wasm|@forgeax\/naga|naga-wasm?)['"]/;
const hits = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (p.endsWith('.ts')) {
      const m = readFileSync(p, 'utf8').match(pat);
      if (m) hits.push({ path: p, hit: m[0] });
    }
  }
}

walk(root);

if (hits.length > 0) {
  process.stderr.write(`AC-06 (c) FAIL: ${root} src imports contain banned packages:\n`);
  for (const h of hits) process.stderr.write(`  ${h.path}: ${h.hit}\n`);
  process.stderr.write(
    `[hint] @forgeax/engine-shader is runtime-only; route build-time work through @forgeax/engine-shader-compiler / @forgeax/engine-vite-plugin-shader instead.\n`,
  );
  process.exit(1);
}
process.stdout.write(`AC-06 (c) OK: ${root} src import grep clean\n`);
