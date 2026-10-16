#!/usr/bin/env node
// fetch-wasm.mjs — Download the pre-built wgpu-wasm pkg/ bundle from GitHub
// Releases so no-Rust consumers (editor standalone, CI typecheck) can resolve
// @forgeax/engine-wgpu-wasm without a Rust + wasm-pack toolchain.
//
// Unlike @forgeax/engine-fbx (single self-loading .wasm), the wgpu-wasm pkg/
// carries hand-generated wasm-bindgen glue (.js) + two .d.ts files that cannot
// be regenerated from the .wasm alone. So the release asset is the WHOLE pkg/
// packed as a content-keyed .tar.gz; this script downloads and extracts it into
// packages/wgpu-wasm/pkg/.
//
// The content key (see content-key.mjs) is the SSOT shared with the CI publish
// job, so producer and consumer always agree on the asset name.
//
// Usage:
//   pnpm -F @forgeax/engine-wgpu-wasm fetch-wasm
//   node scripts/fetch-wasm.mjs
//
// Environment:
//   GITHUB_TOKEN — optional Bearer token for private-repo auth. Falls back to
//   `gh auth token`. Anonymous requests work for public repos.
//   FORGEAX_SKIP_WGPU_WASM_FETCH — if set, exit 0 immediately (used by the
//   non-fatal postinstall path when the toolchain owner opts out).
//
// Exit codes: 0 on success (or skip); 1 on any FetchError. The postinstall
// wrapper treats a non-zero exit as a warning, never a hard install failure
// (graceful degradation: architecture-principles #9).

import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FetchError, getGitOrigin, getReleaseAsset, downloadAsset, extractTarball } from '../../../scripts/lib/fetch-wasm-lib.mjs';
import { PKG_ROOT, RELEASE_TAG, resolveAsset } from './content-key.mjs';
import { verifyProvenance } from './provenance.mjs';

const PKG_DIR = join(PKG_ROOT, 'pkg');
const TMP_TARBALL = join(PKG_ROOT, '.pkg-fetch.tar.gz');

const PKG_LABEL = 'wgpu-wasm';
const BUILD_HINT =
  'compile locally with `pnpm -F @forgeax/engine-wgpu-wasm build:wasm` (needs Rust + wasm-pack; see CONTRIBUTING §Rust toolchain)';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.FORGEAX_SKIP_WGPU_WASM_FETCH) {
    console.log('fetch-wasm: FORGEAX_SKIP_WGPU_WASM_FETCH set — skipping.');
    return;
  }

  console.log('Resolving git origin...');
  const { owner, repo } = getGitOrigin();
  console.log(`  origin: ${owner}/${repo}`);

  console.log('Computing content key (src/**/*.rs + Cargo.{toml,lock} + rust-toolchain.toml + build.sh)...');
  const { sha256, assetName } = await resolveAsset();
  const expectedSourceContentKey = `sha256-${sha256}`;
  console.log(`  content SHA256: ${sha256}`);
  console.log(`  asset name:     ${assetName}`);

  console.log(`Fetching release tag "${RELEASE_TAG}" from ${owner}/${repo}...`);
  const asset = await getReleaseAsset(owner, repo, RELEASE_TAG, assetName, {
    pkgLabel: PKG_LABEL,
    buildHint: BUILD_HINT,
    missingAssetHint:
      'The wgpu-wasm sources have uncommitted changes, or the release for this content is not yet published.',
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
  await verifyProvenance({ expectedSourceContentKey });

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
