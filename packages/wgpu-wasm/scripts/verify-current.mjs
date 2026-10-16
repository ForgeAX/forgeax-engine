#!/usr/bin/env node
// Fail a source build closed when the ignored pkg/ bundle belongs to another
// Rust source content key. Postinstall remains best-effort, but build consumers
// must never silently compile against a stale generated binding.

import { verifyProvenance } from './provenance.mjs';

try {
  await verifyProvenance();
  process.stdout.write('[wgpu-wasm] pkg/ provenance matches current source content key.\n');
} catch (error) {
  console.error(`[wgpu-wasm] current pkg/ verification failed: ${error.message || error}`);
  console.error(
    '  hydrate with `pnpm -F @forgeax/engine-wgpu-wasm fetch-wasm` or build:wasm, then retry the build.',
  );
  process.exit(1);
}
