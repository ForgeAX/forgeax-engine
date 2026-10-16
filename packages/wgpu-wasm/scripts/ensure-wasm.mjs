#!/usr/bin/env node
// ensure-wasm.mjs — postinstall best-effort hydration of the wgpu-wasm pkg/.
// Thin config over scripts/lib/ensure-wasm-lib.mjs (shared with -fbx, -codec).
//
// pkg/ is a wasm-pack build artifact, not committed (ufbx-style release; see
// .gitignore). The TS entry STATICALLY imports pkg/wgpu_wasm.js, so a no-Rust
// clone with an empty pkg/ fails to typecheck — this fills that gap at install
// time. Failure is non-fatal (graceful degradation): the typecheck/build that
// needs pkg/ fails later with a clear error if neither release nor toolchain
// is available.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG = join(SCRIPT_DIR, '..', 'pkg');
const presenceMarkers = [join(PKG, 'wgpu_wasm.js'), join(PKG, 'provenance.json')];
const { verifyProvenance } = await import('./provenance.mjs');
let ready = false;
if (presenceMarkers.every(existsSync)) {
  try {
    const { resolveAsset } = await import('./content-key.mjs');
    const source = await resolveAsset();
    await verifyProvenance({ expectedSourceContentKey: `sha256-${source.sha256}` });
    ready = true;
    process.stdout.write('[wgpu-wasm] pkg/ WASM and provenance already present -- skipping fetch.\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[wgpu-wasm] existing pkg/ provenance rejected: ${error.message}\n`);
  }
}
const { ensureWasm } = await import('../../../scripts/lib/ensure-wasm-lib.mjs');

process.exit(
  ensureWasm({
    pkgLabel: 'wgpu-wasm',
    presenceMarkers,
    ready,
    fetchScript: join(SCRIPT_DIR, 'fetch-wasm.mjs'),
    skipEnv: 'FORGEAX_SKIP_WGPU_WASM_FETCH',
    buildHint:
      'pnpm -F @forgeax/engine-wgpu-wasm fetch-wasm  (needs network + published release)\n' +
      '        or pnpm -F @forgeax/engine-wgpu-wasm build:wasm  (needs Rust + wasm-pack)',
  }),
);
