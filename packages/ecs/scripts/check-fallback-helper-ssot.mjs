#!/usr/bin/env node
// feat-20260517-spawn-default-fallback / M1 / t2.
//
// AC-05 grep gate: assert the layer-3 typeDefault table is physically
// SSOT-located in packages/ecs/src/component-default-fallback.ts.
//
// Two characteristic features mark a layer-3 typeDefault implementation:
//   (1) the dispatch shape `=== 'array<entity>'` within +/- 5 lines of
//       a `ENTITY_NULL_RAW` reference (table arm match co-located with
//       the entity sentinel — tight window scoping rejects false
//       positives where ENTITY_NULL_RAW is used as a column sentinel
//       far away from the array<entity> literal);
//   (2) the function name `typeDefault(` defined by literal text.
//
// Either feature appearing outside the helper file -> the gate fails
// with a structured `[reason] / [rerun] / [hint]` triple. The .test.ts
// + reviewer.md / persona files are exempt (test fixtures are scanned
// under a fixture path only when --scan-fixtures is passed; same idiom
// as packages/ecs/scripts/grep-no-string-view-import.mjs).
//
// On no hits in default mode -> exits 0.
//
// Layered coverage:
//   - ROOTS: packages/ + apps/ + templates/  (live source under monorepo)
//   - SKIP_DIRS: node_modules / dist / .cache / .venv / .git
//   - CODE_EXTS: .ts / .mts / .cts / .tsx / .js / .mjs / .cjs
//   - SELF_EXEMPT_FILES: this script + the helper file + the helper
//                        test file
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';

const ROOTS = ['packages', 'apps', 'templates'];

const SELF_EXEMPT_FILES = new Set([
  'packages/ecs/scripts/check-fallback-helper-ssot.mjs',
  'packages/ecs/src/component-default-fallback.ts',
  'packages/ecs/src/__tests__/hierarchy.unit.test.ts',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.cache',
  'test-output',
  '.venv',
  '.git',
]);

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

const FIXTURE_DIR_FRAGMENT = `${sep}scripts${sep}__tests__${sep}fixtures${sep}`;

// (1) The layer-3 table signature: `=== 'array<entity>'` paired with
// `return [];` within +/- 3 lines (the unique entity[] arm — entity-
// remap layer-1 sites push into a runtime array, NOT `return [];`).
// Window scoping keeps the gate immune to legitimate layer-1 entity
// remap arms in scene-instance-container.ts post-helper swap.
//
// (2) function name `typeDefault(` literally — the helper's private
// dispatch function.
const RE_TABLE_ARM_ARRAY_ENTITY = /===\s*'array<entity>'/;
const RE_RETURN_EMPTY_ARRAY = /\breturn\s*\[\s*\]\s*;?/;
const RE_FN_NAME = /\bfunction\s+typeDefault\s*\(/;
const TABLE_WINDOW = 3;

const hits = [];

function walk(dir, scanFixtures) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(p, scanFixtures);
      continue;
    }
    if (!scanFixtures && p.includes(FIXTURE_DIR_FRAGMENT)) continue;
    if (p.endsWith('.d.ts') || p.endsWith('.d.mts')) continue;
    const ext = p.slice(p.lastIndexOf('.'));
    if (!CODE_EXTS.has(ext)) continue;
    if (SELF_EXEMPT_FILES.has(p)) continue;
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let tableHit = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (!RE_TABLE_ARM_ARRAY_ENTITY.test(lines[i])) continue;
      const lo = Math.max(0, i - TABLE_WINDOW);
      const hi = Math.min(lines.length, i + TABLE_WINDOW + 1);
      for (let j = lo; j < hi; j += 1) {
        if (RE_RETURN_EMPTY_ARRAY.test(lines[j])) {
          tableHit = true;
          break;
        }
      }
      if (tableHit) break;
    }
    const fnHit = RE_FN_NAME.test(text);
    if (tableHit || fnHit) {
      hits.push({
        path: p,
        reason: tableHit && fnHit
          ? "=== 'array<entity>' paired with return [] within +/-3 lines + function typeDefault(...)"
          : tableHit
          ? "=== 'array<entity>' paired with return [] within +/-3 lines (layer-3 table)"
          : 'function typeDefault(...) defined',
      });
    }
  }
}

const args = process.argv.slice(2);
const scanFixtures = args.includes('--scan-fixtures');
const customRoots = args.filter((a) => !a.startsWith('--'));
const roots = customRoots.length > 0 ? customRoots : ROOTS;

for (const root of roots) {
  walk(root, scanFixtures);
}

if (hits.length > 0) {
  for (const h of hits) {
    process.stderr.write(`[reason] layer-3 typeDefault table feature in ${h.path}: ${h.reason}\n`);
  }
  process.stderr.write('[rerun] node packages/ecs/scripts/check-fallback-helper-ssot.mjs\n');
  process.stderr.write(
    '[hint] layer-3 typeDefault table is SSOT-located in ' +
      'packages/ecs/src/component-default-fallback.ts (feat-20260517-' +
      'spawn-default-fallback / AC-05). Move dispatch into ' +
      "fillComponentDefaults / typeDefault and import the helper instead. " +
      'See AGENTS.md Breaking changes 2026-05-17 row.\n',
  );
  process.exit(1);
}

process.stdout.write(
  '[grep:fallback-helper-ssot] OK — layer-3 typeDefault table is SSOT-located.\n',
);
