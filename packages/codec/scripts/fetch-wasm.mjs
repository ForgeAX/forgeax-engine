#!/usr/bin/env node
// fetch-wasm.mjs — Download the pre-built basis-wasm pkg/ bundle from GitHub
// Releases so no-Emscripten consumers (Studio setup, editor standalone, CI
// typecheck) can resolve @forgeax/engine-codec without an emcc toolchain and,
// crucially, without the multi-minute -O3 basis_universal encoder compile.
//
// Like @forgeax/engine-wgpu-wasm, the codec pkg/ carries multiple files (two
// emscripten glue .mjs + two .wasm, nested one level under encode/) that cannot
// be regenerated from a single .wasm, so the release asset is the WHOLE pkg/
// packed as a content-keyed .tar.gz; this script downloads and extracts it into
// packages/codec/pkg/.
//
// The content key (see content-key.mjs) is the SSOT shared with the CI publish
// job, so producer and consumer always agree on the asset name.
//
// Usage:
//   pnpm -F @forgeax/engine-codec fetch-wasm
//   node scripts/fetch-wasm.mjs
//
// Environment:
//   GITHUB_TOKEN — optional Bearer token for private-repo auth. Falls back to
//   `gh auth token`. Anonymous requests work for public repos.
//   FORGEAX_SKIP_CODEC_WASM_FETCH — if set, exit 0 immediately (used by the
//   non-fatal opt-out path when the toolchain owner wants to build locally).
//
// Exit codes: 0 on success (or skip); 1 on any FetchError. Callers that want a
// build fallback treat a non-zero exit as "release unavailable, compile via
// build:wasm" (graceful degradation: architecture-principles #9).

import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { FetchError, getGitOrigin, getReleaseAsset, downloadAsset, extractTarball } from '../../../scripts/lib/fetch-wasm-lib.mjs';
import { PKG_ROOT, RELEASE_TAG, resolveAsset } from './content-key.mjs';

const PKG_DIR = join(PKG_ROOT, 'pkg');
const TMP_TARBALL = join(PKG_ROOT, '.pkg-fetch.tar.gz');

const PKG_LABEL = 'basis-wasm';
const BUILD_HINT =
  'compile locally with `pnpm -F @forgeax/engine-codec build:wasm` (needs the Emscripten emcc toolchain)';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.FORGEAX_SKIP_CODEC_WASM_FETCH) {
    console.log('fetch-wasm: FORGEAX_SKIP_CODEC_WASM_FETCH set — skipping.');
    return;
  }

  console.log('Resolving git origin...');
  const { owner, repo } = getGitOrigin();
  console.log(`  origin: ${owner}/${repo}`);

  console.log('Computing content key (fetch-basis.mjs + build-wasm.mjs)...');
  const { sha256, assetName } = await resolveAsset();
  console.log(`  content SHA256: ${sha256}`);
  console.log(`  asset name:     ${assetName}`);

  console.log(`Fetching release tag "${RELEASE_TAG}" from ${owner}/${repo}...`);
  const asset = await getReleaseAsset(owner, repo, RELEASE_TAG, assetName, {
    pkgLabel: PKG_LABEL,
    buildHint: BUILD_HINT,
    missingAssetHint:
      'The codec build scripts have uncommitted changes, or the release for this content is not yet published.',
  });

  console.log(`Downloading ${assetName} (${(asset.size / 1024).toFixed(0)} KB)...`);
  await downloadAsset(asset, TMP_TARBALL, {
    owner,
    repo,
    tag: RELEASE_TAG,
    pkgLabel: PKG_LABEL,
    buildHint: BUILD_HINT,
  });

  console.log(`Extracting into ${PKG_DIR} ...`);
  await extractTarball(TMP_TARBALL, PKG_DIR);
  await rm(TMP_TARBALL, { force: true });

  const members = await readdir(PKG_DIR);
  console.log(`  pkg/ now holds: ${members.join(', ')}`);
  console.log('Done.');
}

main().catch(async (e) => {
  await rm(TMP_TARBALL, { force: true }).catch(() => {});
  if (e instanceof FetchError) {
    console.error(`\n[${e.code}] ${e.message}`);
    console.error(`Hint: ${e.hint}`);
  } else {
    console.error('\nUnexpected error:', e.message || e);
  }
  process.exit(1);
});
