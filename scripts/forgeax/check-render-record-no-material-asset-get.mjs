#!/usr/bin/env node
// AC-07 RenderSystem record material-asset-get reverse-grep gate
// (feat-20260517-merge-mesh-renderer-material-renderer M3 / w8;
// plan-strategy section 4 R-A6 / requirements AC-07 reverse-grep precision).
//
// Reverse-grep enforcement of the extract -> record Pipeline Isolation
// boundary on `packages/render/src/render-system-record.ts`. The record
// stage MUST consume material data only from the `RenderableSnapshot.material`
// POD that the extract stage produced; it MUST NOT directly reach into
// `internals.assets.get<MaterialAsset>(...)` or smuggle a typed cast over
// `firstMaterial` to read material asset fields. The mesh-handle path
// (`internals.assets.get(...assetHandle...)` for the geometry buffers) is
// intentionally retained -- this gate targets material-asset reads only.
//
// Three banned patterns (plan-strategy R-A6):
//   1. `internals.assets.get<MaterialAsset>` -- direct typed lookup of the
//      MaterialAsset closed-union from the registry; bypasses snapshot.
//   2. `firstMaterial as { ... }` -- typed cast over the snapshot's
//      `material` POD; the cast was the pre-w10 escape hatch for reading
//      `baseColorTexture`, now a first-class snapshot field.
//   3. `getTextureGpuView(baseColorHandle)` reaching the texture-view
//      through a `baseColor*Handle` resolved INSIDE the record stage from
//      the cast; once `firstMaterial.baseColorTexture` reads cleanly the
//      record stage may still call `getTextureGpuView`, but only with the
//      handle pulled directly from the snapshot field. This gate uses the
//      identifier name `baseColorHandle` as the literal regrowth signal
//      (see plan-strategy R-A6 (iii)).
//
// CLI:
//   node scripts/forgeax/check-render-record-no-material-asset-get.mjs
//   node scripts/forgeax/check-render-record-no-material-asset-get.mjs --help

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
// feat-20260704 M3/w24: the record-stage monolith split into the
// packages/render/src/record/ cluster. The gate scans every .ts in that
// directory so a banned MaterialAsset-read pattern cannot regrow in any
// sibling file (plan-strategy D-2 no-root-shim + section 5.6 no empty-pass).
const RECORD_DIR = resolve(REPO_ROOT, 'packages/render/src/record');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    `${[
      'check-render-record-no-material-asset-get: AC-07 reverse-grep',
      '',
      'Usage:',
      '  node scripts/forgeax/check-render-record-no-material-asset-get.mjs',
      '',
      'Asserts that no file under packages/render/src/record/ does NOT',
      'reach `internals.assets.get<MaterialAsset>` directly, does NOT cast',
      '`firstMaterial` to read texture handles, and does NOT name the',
      '`baseColorHandle` local that the cast pattern produced. The mesh',
      '`internals.assets.get` path remains valid -- this gate is precise',
      'to MaterialAsset access only.',
      '',
      'Exit codes:',
      '  0  no banned patterns found',
      '  1  one or more banned patterns regrew',
    ].join('\n')}\n`,
  );
  process.exit(0);
}

let targetFiles;
try {
  targetFiles = readdirSync(RECORD_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(RECORD_DIR, name))
    .sort();
} catch {
  process.stderr.write(`error: cannot read record cluster dir ${RECORD_DIR}\n`);
  process.exit(2);
}
if (targetFiles.length === 0) {
  process.stderr.write(`error: no .ts files found under ${RECORD_DIR}\n`);
  process.exit(2);
}

const failures = [];

const banned = [
  {
    code: 'AC-07-MATERIAL-ASSET-GET',
    re: /internals\.assets\.get\s*<\s*MaterialAsset\s*>/,
    hint: 'record must not reach `internals.assets.get<MaterialAsset>` directly. Read material fields from `RenderableSnapshot.material` (extract owns the asset->snapshot translation; charter P5 producer/consumer split).',
  },
  {
    code: 'AC-07-FIRSTMATERIAL-CAST',
    re: /firstMaterial\s+as\s+\{/,
    hint: 'record must not cast `firstMaterial` to a structural type to access fields. The MaterialSnapshot type already declares `baseColorTexture?` / `sampler?` / `materialShaderId`; access them directly.',
  },
  {
    code: 'AC-07-BASECOLORHANDLE-LOCAL',
    re: /\bbaseColorHandle\b/,
    hint: 'record must not introduce a `baseColorHandle` local resolved from a `firstMaterial as { ... }` cast. Pull `firstMaterial.baseColorTexture` directly off the snapshot field and pass it to `getTextureGpuView` if needed.',
  },
];

for (const file of targetFiles) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const rel = file.slice(REPO_ROOT.length + 1);
  for (const rule of banned) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (rule.re.test(line)) {
        failures.push({
          code: rule.code,
          file: rel,
          line: i + 1,
          snippet: line.slice(0, 160).trim(),
          hint: rule.hint,
        });
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write('AC-07 record reverse-grep gate FAIL:\n');
  for (const f of failures) {
    process.stderr.write(`  [${f.code}] ${f.file}:${f.line}: ${f.snippet}\n`);
    process.stderr.write(`    hint: ${f.hint}\n`);
  }
  process.exit(1);
}

process.stdout.write('AC-07 record reverse-grep gate PASS\n');
