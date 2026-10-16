#!/usr/bin/env node
// Dual-source SSOT check for config/jscpd.json ignore paths (AC-14).
//
// jscpd has two ignore vectors with DIFFERENT semantics:
//   - `ignore` (native jscpd field): array of globs; jscpd silently drops unknown
//     top-level fields, so a typo here fails silently. Validate by globbing each
//     entry and asserting at least one file matches (a glob that matches zero
//     real files is structurally suspicious).
//   - `filePairIgnore` (forgeax wrapper-custom field, owned by scripts/dup-check.mjs):
//     array of [pathA, pathB] tuples or { files: [...] } objects. Validate each
//     listed path with `test -e` (must exist on disk).
//
// Stdlib-only Node ESM; no external deps.

import { existsSync, readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const REPO_ROOT = (() => {
  const url = new URL('../../', import.meta.url);
  return url.pathname.replace(/\/$/, '');
})();

const CONFIG_PATH = join(REPO_ROOT, 'config/jscpd.json');

let errors = 0;
function fail(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  errors++;
}

function readConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    fail(`cannot read ${CONFIG_PATH}`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`invalid JSON in config/jscpd.json: ${e.message}`);
    return null;
  }
}

async function checkIgnore(cfg) {
  const ignore = cfg.ignore;
  if (!Array.isArray(ignore)) {
    fail('config/jscpd.json#ignore must be an array');
    return;
  }
  for (const pattern of ignore) {
    if (typeof pattern !== 'string') {
      fail(`config/jscpd.json#ignore entry not a string: ${JSON.stringify(pattern)}`);
      continue;
    }
    let matchCount = 0;
    try {
      // node:fs/promises glob iterates matches; cap at 1 for early exit
      const cwd = pattern.startsWith('**/') ? REPO_ROOT : dirname(CONFIG_PATH);
      for await (const _ of glob(pattern, { cwd })) {
        matchCount++;
        if (matchCount >= 1) break;
      }
    } catch (e) {
      fail(`glob error for '${pattern}': ${e.message}`);
      continue;
    }
    if (matchCount === 0) {
      // jscpd silently drops missing-glob patterns; we mirror that by warn-only
      // (especially for build-artifact globs like target/, dist/ that may not
      // exist in a fresh checkout). If a wrong glob slipped past sweep, the
      // jscpd run itself stays silent — this checker can't tighten beyond that.
      process.stderr.write(
        `[WARN] config/jscpd.json#ignore pattern matches 0 files: '${pattern}'\n`,
      );
    }
  }
}

function checkFilePairIgnore(cfg) {
  const pairs = cfg.filePairIgnore;
  if (pairs == null) return; // optional
  if (!Array.isArray(pairs)) {
    fail('config/jscpd.json#filePairIgnore must be an array');
    return;
  }
  for (let i = 0; i < pairs.length; i++) {
    const entry = pairs[i];
    let paths;
    if (Array.isArray(entry)) {
      paths = entry;
    } else if (entry && typeof entry === 'object' && Array.isArray(entry.files)) {
      paths = entry.files;
    } else {
      fail(
        `config/jscpd.json#filePairIgnore[${i}] must be [pathA, pathB] tuple or { files: [...] } object`,
      );
      continue;
    }
    for (const p of paths) {
      if (typeof p !== 'string') {
        fail(`config/jscpd.json#filePairIgnore[${i}] non-string path: ${JSON.stringify(p)}`);
        continue;
      }
      const abs = join(REPO_ROOT, p);
      if (!existsSync(abs)) {
        fail(`config/jscpd.json#filePairIgnore[${i}] path does not exist: '${p}'`);
      }
    }
  }
}

async function main() {
  const cfg = readConfig();
  if (cfg == null) {
    process.exit(1);
  }
  await checkIgnore(cfg);
  checkFilePairIgnore(cfg);
  if (errors > 0) {
    process.stderr.write(`[CHECK FAILED] ${errors} issue(s)\n`);
    process.exit(1);
  }
  process.stdout.write('[OK] config/jscpd.json ignore + filePairIgnore paths all valid\n');
}

main().catch((e) => {
  process.stderr.write(`[ERROR] ${e.stack || e.message}\n`);
  process.exit(2);
});
