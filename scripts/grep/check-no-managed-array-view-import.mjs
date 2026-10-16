#!/usr/bin/env node
// AC-10 / w23 (feat-20260515-buffer-array-vocab-collapse M5): assert that
// `FixedArrayView<T>` / `VarArrayView<T>` value-shape exports cannot be
// re-imported anywhere in the live source tree. The view classes were
// physically deleted at M2 / w10 (file packages/ecs/src/managed-array-view.ts
// removed) along with their re-export from @forgeax/engine-ecs; the new
// surface is `world.push` / `world.pop` / `world.capacity` plus the
// TypedArray read-only snapshot returned by `world.get(e, C).unwrap().<f>`.
//
// Banned pattern (regex; case-sensitive):
//   - `import { ... VarArrayView ... }`
//   - `import { ... FixedArrayView ... }`
//   - `import { VarArrayView } from '...'`
//   - `import type { FixedArrayView } from '...'`
//   - any `export { ... (Var|Fixed)ArrayView ... }` re-export shell
//
// Files scanned: TS / JS source under packages/ + apps/ + templates/.
// Markdown docs are scanned separately (they retain historical mentions);
// .forgeax-harness/ history is exempt by virtue of not being scanned.
//
// Self-exempt: this gate file plus the existing single-exit gate file
// (`packages/ecs/scripts/check-single-exit.mjs`) which carries the
// historical GATED_SYMBOLS literal `'VarArrayView'` / `'FixedArrayView'`
// from the previous loop family for backward error-message clarity. The
// single-exit gate is updated in w27 to drop the two literals; this gate
// is the structural fail-fast against re-introduction.
//
// Pattern + zero-dep stdio mirrors scripts/grep/check-asset-registry-instanced-removed.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOTS = ['packages', 'apps', 'templates'];

const SELF_EXEMPT = new Set(['scripts/grep/check-no-managed-array-view-import.mjs']);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.cache', 'test-output']);

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

// Match `import` / `export ... from` statements that name VarArrayView or
// FixedArrayView in their named-binding list. The regex is anchored on the
// keyword sequence to avoid catching unrelated identifiers in comments
// (those are stripped first anyway).
const RE_IMPORT_NAMED =
  /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\b(VarArrayView|FixedArrayView)\b[^}]*\}\s*(?:from\s*['"][^'"]+['"])?/m;

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const hits = [];

function walk(dir) {
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
      walk(p);
      continue;
    }
    const ext = p.slice(p.lastIndexOf('.'));
    if (!CODE_EXTS.has(ext)) continue;
    if (SELF_EXEMPT.has(p)) continue;
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripComments(text);
    const m = stripped.match(RE_IMPORT_NAMED);
    if (m) {
      hits.push({ path: p, literal: m[1], snippet: m[0].slice(0, 200) });
    }
  }
}

for (const root of ROOTS) {
  walk(root);
}

if (hits.length > 0) {
  console.error(
    '[check-no-managed-array-view-import] AC-10 violated: deleted ' +
      'value-shape imports re-appeared in non-comment source:',
  );
  for (const h of hits) {
    console.error(`  - ${h.literal}  in  ${h.path}`);
    console.error(`      ${h.snippet}`);
  }
  console.error(
    '\nfeat-20260515-buffer-array-vocab-collapse M2 / w10 deleted ' +
      'packages/ecs/src/managed-array-view.ts (FixedArrayView<T> + ' +
      'VarArrayView<T>). The replacement surface is the World command ' +
      'triple `world.push(e, C, field, v)` / `world.pop(e, C, field)` / ' +
      '`world.capacity(e, C, field)` plus the TypedArray read-only ' +
      'snapshot from `world.get(e, C).unwrap().<arrayField>`. ' +
      'See AGENTS.md §Breaking changes 2026-05-15 row.',
  );
  process.exit(1);
}

console.log(
  '[check-no-managed-array-view-import] OK — deleted view-class imports ' +
    'absent from packages/ apps/ templates/ live code.',
);
