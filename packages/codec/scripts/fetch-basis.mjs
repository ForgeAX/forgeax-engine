#!/usr/bin/env node
// fetch-basis.mjs -- Download + pin the BinomialLLC/basis_universal C++ source
// tree needed to self-build the transcoder + encoder WASM (see build-wasm.mjs).
//
// Mirrors the fbx/ufbx precedent (packages/fbx/scripts/fetch-ufbx.mjs): a
// pinned VERSION constant + GitHub download + skip-if-exists idempotency. The
// vendored source lands in packages/codec/vendor/basis/ which is gitignored
// (zero-binary invariant, AC-12) -- never committed, always re-fetched from the
// pinned commit locally / in CI.
//
// Pin: plan-strategy D-2. The commit below is the exact checkout the
// knowledge-base source analyses (transcoder API / encoder modes / CMake
// flags) were produced against, so build-wasm.mjs's flag set stays in lockstep
// with the KB. `git describe` on this commit = v2_10_final_snapshot-62-g1b33fd5
// (basis lib version "2.50").
//
// Usage: node packages/codec/scripts/fetch-basis.mjs

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODEC_ROOT = join(__dirname, '..');
const VENDOR_DIR = join(CODEC_ROOT, 'vendor', 'basis');

// --- Pin (D-2) --------------------------------------------------------------
const VERSION = {
  commit: '1b33fd5098c6e7b58324146b8f5518cbb4cdfb72',
  describe: 'v2_10_final_snapshot-62-g1b33fd5',
  lib: '2.50',
};

// Subtrees copied out of the upstream tree into VENDOR_DIR. Whole directories
// are copied (not a hand-picked .cpp list) so every relative #include of a
// sibling .h / .inc / .inl resolves without a second manifest to maintain --
// the .cpp compile list lives in build-wasm.mjs, guarded there against drift.
const SUBTREES = [
  'transcoder',
  'encoder',
  'zstd',
  'webgl/transcoder',
];
const EXTRA_FILES = ['LICENSE'];

// An offline source is an explicit caller input, never a documentation checkout.
const LOCAL_CLONE = process.env.FORGEAX_BASIS_SOURCE_DIR;

const VERSION_MARKER = join(VENDOR_DIR, '.basis-pin');

function isAlreadyFetched() {
  if (!existsSync(VERSION_MARKER)) return false;
  const marker = readFileSync(VERSION_MARKER, 'utf8').trim();
  if (marker !== VERSION.commit) return false;
  // Sanity: the two canonical entry sources must be present.
  return (
    existsSync(join(VENDOR_DIR, 'transcoder', 'basisu_transcoder.cpp')) &&
    existsSync(join(VENDOR_DIR, 'encoder', 'basisu_comp.cpp'))
  );
}

function copyFromRoot(srcRoot) {
  if (existsSync(VENDOR_DIR)) rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
  for (const sub of SUBTREES) {
    const from = join(srcRoot, sub);
    if (!existsSync(from)) throw new Error(`missing subtree in source: ${sub}`);
    cpSync(from, join(VENDOR_DIR, sub), { recursive: true });
  }
  for (const f of EXTRA_FILES) {
    const from = join(srcRoot, f);
    if (!existsSync(from)) throw new Error(`missing file in source: ${f}`);
    cpSync(from, join(VENDOR_DIR, f));
  }
  writeFileSync(VERSION_MARKER, `${VERSION.commit}\n`);
}

async function fetchFromGitHub() {
  const url = `https://codeload.github.com/BinomialLLC/basis_universal/tar.gz/${VERSION.commit}`;
  const tmp = mkdtempSync(join(tmpdir(), 'basis-fetch-'));
  const tarPath = join(tmp, 'basis.tar.gz');
  try {
    console.log(`Fetching ${url} ...`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    writeFileSync(tarPath, buf);
    console.log(`  downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB, extracting ...`);
    const prefix = `basis_universal-${VERSION.commit}`;
    const memberArgs = [...SUBTREES, ...EXTRA_FILES].map((p) => `${prefix}/${p}`).join(' ');
    // Extract only the needed members, stripping the top-level prefix dir.
    execSync(`tar xzf ${tarPath} -C ${tmp} ${memberArgs}`, { stdio: 'inherit' });
    copyFromRoot(join(tmp, prefix));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function fetchFromLocalClone() {
  if (!LOCAL_CLONE || !existsSync(LOCAL_CLONE)) return false;
  let head = '';
  try {
    head = execSync('git rev-parse HEAD', { cwd: LOCAL_CLONE, encoding: 'utf8' }).trim();
    execSync('git diff --quiet HEAD --', { cwd: LOCAL_CLONE, stdio: 'ignore' });
  } catch {
    return false;
  }
  if (head !== VERSION.commit) {
    console.warn(`  local clone at ${head} != pinned ${VERSION.commit}, skipping fallback`);
    return false;
  }
  console.log(`  using pinned local clone: ${LOCAL_CLONE}`);
  copyFromRoot(LOCAL_CLONE);
  return true;
}

async function main() {
  if (isAlreadyFetched()) {
    console.log(`basis source already at pinned ${VERSION.commit}, skipping (delete vendor/basis to re-fetch).`);
    return;
  }
  if (LOCAL_CLONE) {
    if (!fetchFromLocalClone()) throw new Error(`Invalid pinned basis source: ${LOCAL_CLONE}`);
  } else {
    try {
      await fetchFromGitHub();
    } catch (cause) {
      throw new Error(
        'Could not obtain basis source; provide a pinned clone with FORGEAX_BASIS_SOURCE_DIR for offline builds',
        { cause },
      );
    }
  }
  console.log(`Done. Vendored basis ${VERSION.describe} (lib ${VERSION.lib}) -> ${VENDOR_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
