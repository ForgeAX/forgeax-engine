#!/usr/bin/env node
// ensure-wasm.mjs — postinstall best-effort hydration of the codec pkg/ WASM.
// Thin config over scripts/lib/ensure-wasm-lib.mjs (shared with -fbx, -wgpu-wasm).
//
// Why no compile fallback here (matches -wgpu-wasm + -fbx): the basis_universal
// encoder is a multi-minute -O3 emcc compile; doing it inside `bun install`
// would block every dependency install for minutes with no progress. The
// compile fallback lives in Studio's setup.ts (fetch → build:wasm, with
// progress). Bare install stays fast; a consumer with neither a release nor a
// setup.ts run gets the buildHint below.

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG = join(SCRIPT_DIR, '..', 'pkg');
const presenceMarkers = [
  join(PKG, 'basis_transcoder.mjs'),
  join(PKG, 'basis_transcoder.wasm'),
  join(PKG, 'encode', 'basis_encoder.mjs'),
  join(PKG, 'encode', 'basis_encoder.wasm'),
];
const ready = presenceMarkers.every((path) => {
  if (!existsSync(path)) return false;
  const stats = statSync(path);
  return stats.isFile() && stats.size > 0;
});
if (process.argv.includes('--check')) {
  if (!ready) process.stderr.write('[codec] complete nonempty transcoder and encoder payloads are required.\n');
  process.exit(ready ? 0 : 1);
}
if (ready) {
  process.stdout.write('[codec] pkg/ WASM already present -- skipping fetch.\n');
  process.exit(0);
}
const { ensureWasm } = await import('../../../scripts/lib/ensure-wasm-lib.mjs');

process.exit(
  ensureWasm({
    pkgLabel: 'codec',
    presenceMarkers,
    ready,
    fetchScript: join(SCRIPT_DIR, 'fetch-wasm.mjs'),
    skipEnv: 'FORGEAX_SKIP_CODEC_WASM_FETCH',
    buildHint:
      'run Studio `bun fx setup` (fetch → compile fallback), or build locally with\n' +
      '        pnpm -F @forgeax/engine-codec build:wasm  (needs Emscripten emcc)',
  }),
);
