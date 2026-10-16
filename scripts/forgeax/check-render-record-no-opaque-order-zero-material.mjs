#!/usr/bin/env node
// AC-06 RenderSystem record opaque-order-zero-material reverse-grep gate
// (bug-20260522-per-entity-material-texture-binding D-3;
// plan-strategy section 2 D-3 + requirements AC-06 reverse-grep precision).
//
// Reverse-grep enforcement of the per-entity material texture binding fix
// on `packages/render/src/render-system-record.ts`. The record stage MUST
// NOT resolve baseColorTexture globally from `validatedOrdered[0]?.source
// .material` and MUST NOT create a single shared material BindGroup outside
// the per-entity draw loop. Each entity must get its own per-entity material
// BG created inside the loop.
//
// Two banned patterns:
//   1. `validatedOrdered[0]?.source.material` -- global [0]-indexed
//      material resolution from the first validated renderable; the pre-fix
//      defect root cause.
//   2. The `materialBindGroup` identifier (variable used for the shared
//      pre-loop BG instance). Post-fix the variable is renamed to
//      `perEntityBgResult.value` and created inside the per-entity loop.
//
// CLI:
//   node scripts/forgeax/check-render-record-no-opaque-order-zero-material.mjs
//   node scripts/forgeax/check-render-record-no-opaque-order-zero-material.mjs --help

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
// feat-20260704 M3/w24: the record-stage monolith split into the
// packages/render/src/record/ cluster. The gate now scans every .ts in
// that directory so a banned pattern cannot regrow in any sibling file
// (plan-strategy D-2 no-root-shim + section 5.6 no empty-pass).
const RECORD_DIR = resolve(REPO_ROOT, 'packages/render/src/record');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    `${[
      'check-render-record-no-opaque-order-zero-material: AC-06 reverse-grep',
      '',
      'Usage:',
      '  node scripts/forgeax/check-render-record-no-opaque-order-zero-material.mjs',
      '',
      'Asserts that no file under packages/render/src/record/ does NOT',
      'resolve material textureView globally from validatedOrdered[0]?.source',
      '.material and does NOT export a shared `materialBindGroup` variable',
      'created outside the per-entity draw loop.',
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
    code: 'AC-06-VALIDATED-ORDERED-ZERO-MATERIAL',
    re: /validatedOrdered\s*\[\s*0\s*\]\s*\?\.\s*source\s*\.\s*material/,
    hint: 'record must NOT resolve material from validatedOrdered[0]?.source.material globally. Each entity must read entry.source.material from inside the per-entity draw loop. See bug-20260522 D-2 per-entity createBindGroup fix.',
  },
  {
    code: 'AC-06-SHARED-MATERIAL-BINDGROUP',
    re: /\bmaterialBindGroup\b/,
    hint: 'record must NOT create a shared materialBindGroup variable outside the per-entity draw loop. Post-fix, each entity creates its own per-entity BG as perEntityBgResult (created inside the loop with perEntityBgResult = device.createBindGroup(...)).',
  },
];

for (const file of targetFiles) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const rel = file.slice(REPO_ROOT.length + 1);
  for (const rule of banned) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      // Skip comment-only lines (// or /* block comments). The gate
      // enforces banned patterns in executable code, not in historical
      // comments that describe the pre-fix state (plan-strategy D-3
      // R-5 grep gate precision).
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
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
  process.stderr.write('AC-06 record reverse-grep gate FAIL:\n');
  for (const f of failures) {
    process.stderr.write(`  [${f.code}] ${f.file}:${f.line}: ${f.snippet}\n`);
    process.stderr.write(`    hint: ${f.hint}\n`);
  }
  process.exit(1);
}

process.stdout.write('AC-06 record reverse-grep gate PASS\n');
