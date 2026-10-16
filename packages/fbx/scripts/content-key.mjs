// content-key.mjs — Single source of truth for the fbx-wasm release asset key.
//
// The pkg/ bundle (fbx-wasm.wasm + fbx-wasm.mjs emcc glue) is an emcc build
// artifact — NOT committed to git (zero-binary invariant, see
// packages/fbx/.gitignore). It is published to the `wasm-artifacts` GitHub
// Release, content-keyed so a bundle is uploaded once per unique source state
// and fetched deterministically.
//
// Like @forgeax/engine-wgpu-wasm and @forgeax/engine-codec (and unlike the old
// lone-.wasm scheme), the fbx pkg/ carries TWO files that emcc emits together —
// the .wasm binary plus its self-loading .mjs glue (MODULARIZE + EXPORT_ES6).
// src/wasm.ts imports the .mjs glue at runtime, so a fetch that grabs only the
// .wasm leaves consumers without a loader. The release asset is therefore the
// WHOLE pkg/ packed as a .tar.gz.
//
// What determines pkg/ output, and therefore the content key:
//   - src/native/bridge.c — the hand-written C bridge over ufbx.
//   - scripts/fetch-ufbx.mjs + ufbx-source.lock.json — pin and verify the exact
//     upstream ufbx.h/.c bytes, which are gitignored and downloaded on demand.
//   - scripts/build-wasm.mjs — the emcc flag set that emits the .wasm/.mjs pair
//     bit-for-bit.
//
// Both scripts/fetch-wasm.mjs (consumer) and the CI publish job import this
// module so producer and consumer never disagree on the asset name (Pipeline
// Isolation + SSOT: architecture-principles #1, #4).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(__dirname, '..');

export const RELEASE_TAG = 'wasm-artifacts';
export const UFBX_VERSION = JSON.parse(
  await readFile(join(PKG_ROOT, 'scripts', 'ufbx-source.lock.json'), 'utf8'),
).version;

/**
 * Compute the full SHA-256 (hex) over every input that determines the pkg/
 * output. Path is included in the hash so a rename alone shifts the key.
 *
 * Inputs: the C bridge source + the two build scripts that fully determine the
 * emitted pair (fetch-ufbx.mjs pins the ufbx version, build-wasm.mjs the emcc
 * flags).
 */
export async function computeContentSha256() {
  const inputs = [
    join(PKG_ROOT, 'src', 'native', 'bridge.c'),
    join(PKG_ROOT, 'scripts', 'fetch-ufbx.mjs'),
    join(PKG_ROOT, 'scripts', 'ufbx-source.lock.json'),
    join(PKG_ROOT, 'scripts', 'build-wasm.mjs'),
  ];
  const hash = createHash('sha256');
  for (const path of inputs) {
    const rel = relative(PKG_ROOT, path).split('\\').join('/');
    const content = await readFile(path);
    hash.update(rel);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function buildAssetName(sha8) {
  return `fbx-wasm-${UFBX_VERSION}-${sha8}.tar.gz`;
}

/** Convenience: returns { sha256, sha8, assetName }. */
export async function resolveAsset() {
  const sha256 = await computeContentSha256();
  const sha8 = sha256.slice(0, 8);
  return { sha256, sha8, assetName: buildAssetName(sha8) };
}

// CLI: `node scripts/content-key.mjs` prints the asset name (used by CI shell).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  resolveAsset()
    .then(({ sha256, assetName }) => {
      // Two lines: full sha then asset name, so shell can pick either.
      process.stdout.write(`${sha256}\n${assetName}\n`);
    })
    .catch((e) => {
      console.error('content-key: failed to compute:', e.message || e);
      process.exit(1);
    });
}
