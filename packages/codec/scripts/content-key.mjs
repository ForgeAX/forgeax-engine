// content-key.mjs — Single source of truth for the basis-wasm release asset key.
//
// The pkg/ bundle (basis_transcoder.{mjs,wasm} + encode/basis_encoder.{mjs,wasm})
// is an emcc build artifact — NOT committed to git (zero-binary invariant, see
// packages/codec/.gitignore). It is published to the `wasm-artifacts` GitHub
// Release, content-keyed so a bundle is uploaded once per unique source state
// and fetched deterministically.
//
// Like @forgeax/engine-wgpu-wasm (and unlike @forgeax/engine-fbx's lone .wasm),
// the codec pkg/ carries multiple files — two emscripten glue .mjs + two .wasm,
// nested one level (encode/) — so the release asset is the WHOLE pkg/ packed as
// a .tar.gz.
//
// What determines pkg/ output, and therefore the content key:
//   - scripts/fetch-basis.mjs — pins the exact basis_universal commit
//     (VERSION.commit) + the vendored subtree list. The upstream C++ source is
//     itself gitignored (downloaded on demand), but this pin uniquely fixes it,
//     so hashing the pin script is equivalent to hashing the source tree.
//   - scripts/build-wasm.mjs — the emcc flag sets, compile/link source lists,
//     defines, and the encoder pixel-limit patch. Anything here changes the
//     emitted .wasm/.mjs bit-for-bit.
// Hashing exactly these two scripts (not the transient vendor/ tree) keeps the
// key stable across machines and CI while still shifting on any real change.
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

/**
 * Compute the full SHA-256 (hex) over every input that determines the pkg/
 * output. Path is included in the hash so a rename alone shifts the key.
 *
 * Inputs are the two build scripts that fully determine the emitted bundle:
 * fetch-basis.mjs (source pin) + build-wasm.mjs (emcc flags + patch).
 */
export async function computeContentSha256() {
  const inputs = [
    join(PKG_ROOT, 'scripts', 'fetch-basis.mjs'),
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
  return `basis-wasm-pkg-${sha8}.tar.gz`;
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
