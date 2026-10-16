#!/usr/bin/env node
// AC-06 (a): production dist must not bundle build-time shader compiler
// surface. Plan §S-2 + feat-20260511-naga-rhi-wgpu-merge §D-P6.
//
// banned pattern set (feat-20260511-naga-rhi-wgpu-merge w12 rewrite):
//   - `@forgeax/engine-wgpu-wasm`  (Rust crate + raw bindings; only @forgeax/engine-naga
//                            + @forgeax/engine-rhi-wgpu may import; runtime shader
//                            bundles must never resolve through it)
//   - `@forgeax/engine-naga`       (TS-only build-time shader pipeline shell)
//   - `naga_wasm` / `naga_oil`  (literal symbol leakage from any past Naga
//                            wasm shim variant; covers transitive bundlers
//                            that escape the package-name grep above)
//
// Scope: defaults to packages/shader/dist (the @forgeax/engine-shader runtime
// bundle). Callers may pass an explicit dist root as argv[2]; app builds
// (apps/hello/triangle/dist + apps/hello/cube/dist) intentionally embed
// the wgpu-wasm chunk for the rhi-wgpu fallback path and are out of scope
// for the runtime-shader physical isolation contract (the main-path
// 0-wasm-download invariant is enforced by apps/hello/triangle/scripts/
// check-dist-wasm-count.mjs instead, plan §D-P6 + w14).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.argv[2] ?? 'packages/shader/dist';
const banned =
  /@forgeax\/wgpu-wasm|@forgeax\/naga\b|naga_wasm|naga_oil|require\(["']naga|import.*["']naga/;
const exts = new Set(['.js', '.mjs', '.cjs']);
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
    else if (exts.has(p.slice(p.lastIndexOf('.')))) {
      const m = readFileSync(p, 'utf8').match(banned);
      if (m) hits.push({ path: p, hit: m[0] });
    }
  }
}

walk(root);

if (hits.length > 0) {
  process.stderr.write(
    `AC-06 (a) FAIL: ${root} contains banned build-core symbols (@forgeax/engine-wgpu-wasm | @forgeax/engine-naga | naga_wasm | naga_oil):\n`,
  );
  for (const h of hits) process.stderr.write(`  ${h.path}: '${h.hit}'\n`);
  process.stderr.write(
    `[hint] @forgeax/engine-shader runtime bundle must never resolve through @forgeax/engine-wgpu-wasm or @forgeax/engine-naga; both are build-time only. Trace the import chain from packages/shader/src.\n`,
  );
  process.exit(1);
}
process.stdout.write(`AC-06 (a) OK: no build-core symbols in ${root}\n`);
