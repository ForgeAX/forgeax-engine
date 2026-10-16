#!/usr/bin/env node
// scripts/grep/check-shader-manifest-ssot.mjs - M5 w28 (C-AC-07).
//
// Assert that the slash-tolerant literal for 'shaders/manifest.json' (single
// or double quoted, optional leading slash) appears in exactly one code line
// of packages/vite-plugin-shader/src/shader-manifest-path.ts: the constant definition of
// SHADER_MANIFEST_PATH.
//
// Invocation:
//   node scripts/grep/check-shader-manifest-ssot.mjs
//
// Behaviour:
//   - Read packages/vite-plugin-shader/src/shader-manifest-path.ts.
//   - Strip block comments (/* */) and inline comments (//) per line.
//   - Grep for /['"]\/?shaders\/manifest\.json['"]/ in the remaining code-only text.
//   - exit 0 if exactly 1 line matches and that line is the constant definition.
//   - exit 1 on any other outcome (0 hits = missing constant, >1 hits = leakage).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET = resolve(
  REPO_ROOT,
  'packages',
  'vite-plugin-shader',
  'src',
  'shader-manifest-path.ts',
);

const src = readFileSync(TARGET, 'utf8');

// Strip block comments (multi-line) from the raw source, then split.
const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
// Strip per-line inline comments (//).
const strippedLines = noBlock.split('\n').map((line) => line.replace(/\/\/.*$/, ''));

const pat = /['"]\/?shaders\/manifest\.json['"]/g;
/** @type {Array<{ lineNo: number; text: string }>} */
const hits = [];
for (let i = 0; i < strippedLines.length; i++) {
  const line = strippedLines[i];
  if (pat.test(line)) {
    hits.push({ lineNo: i + 1, text: line.trim() });
  }
}

if (hits.length === 1) {
  const hit = hits[0];
  if (/const\s+SHADER_MANIFEST_PATH/.test(hit.text)) {
    console.log(
      `[check-shader-manifest-ssot] OK -- exactly 1 code line (line ${hit.lineNo}) ` +
        'carries the shaders/manifest.json literal (constant definition).',
    );
    process.exit(0);
  }
  console.error(
    `[check-shader-manifest-ssot] FAIL: 1 hit found (line ${hit.lineNo}) ` +
      `but it is NOT the SHADER_MANIFEST_PATH constant definition.`,
  );
  console.error(`  Text: ${hit.text}`);
  process.exit(1);
}

if (hits.length === 0) {
  console.error(
    '[check-shader-manifest-ssot] FAIL: 0 code lines carry the ' +
      'shaders/manifest.json literal — the constant definition is missing.',
  );
  process.exit(1);
}

console.error(
  `[check-shader-manifest-ssot] FAIL: ${hits.length} code lines carry ` +
    'the shaders/manifest.json literal — must be exactly 1 (the SHADER_MANIFEST_PATH constant).',
);
for (const h of hits) {
  console.error(`  line ${h.lineNo}: ${h.text}`);
}
process.exit(1);
