#!/usr/bin/env node
// AC-13 / R-7: assert the legacy schema-vocab keyword `'entity[]'` (the v1
// OOS-04 placeholder pre-feat-20260514) is fully removed from production
// source surface — code, READMEs, and apps source. The replacement vocab
// is `array<entity>` (ECS-managed variable-length array path).
//
// feat-20260514-ecs-children-instances-managed-buffer-array M2 / M3 / M4 —
// requirements §AC-13 freezes the array-vocab migration; this gate prevents
// silent regression by scanning packages/ apps/ for any string literal
// equal to 'entity[]' (single or double-quoted) within source code.
//
// Banned patterns (regex; case-sensitive):
//   - 'entity[]'   (single-quoted string literal)
//   - "entity[]"   (double-quoted string literal)
//   - `entity[]`   (template literal)
//
// Files scanned: TS / JS source under packages/ + apps/ + templates/.
// Markdown docs are scanned separately by check-readme-array-vocab-mentioned;
// .forgeax-harness/ history is exempt by virtue of not being scanned.
//
// Self-exempt: this gate file plus packages/ecs/README.md (the schema-vocab
// quick-ref table intentionally documents the migration: the legacy-vocab
// row + the new-vocab row both exist for AI users tracing the cut). The
// Markdown vocab gate enforces presence of the new vocab; this gate
// enforces absence of the old vocab in TS / JS only.
//
// Pattern + zero-dep stdio mirrors packages/ecs/scripts/check-single-exit.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOTS = ['packages', 'apps', 'templates'];

const SELF_EXEMPT = new Set(['scripts/grep/check-no-entity-array-literal.mjs']);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.cache', 'test-output']);

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

const RE_LITERAL = /(['"`])entity\[\]\1/g;

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
    RE_LITERAL.lastIndex = 0;
    let m = RE_LITERAL.exec(stripped);
    while (m !== null) {
      hits.push({ path: p, literal: m[0] });
      m = RE_LITERAL.exec(stripped);
    }
  }
}

for (const root of ROOTS) {
  walk(root);
}

if (hits.length > 0) {
  console.error(
    '[check-no-entity-array-literal] AC-13 violated: legacy schema-vocab ' +
      "keyword 'entity[]' re-appeared as a string literal in source:",
  );
  for (const h of hits) {
    console.error(`  - ${h.literal}  in  ${h.path}`);
  }
  console.error(
    '\nfeat-20260514 M2 migrated the entity-list vocab to array<entity> ' +
      '(ECS-managed variable-length path). The legacy entity[] keyword is ' +
      'no longer surfaced through SchemaFieldType. Use array<entity> in ' +
      'defineComponent schemas; consume the field via FixedArrayView /' +
      ' VarArrayView. See packages/ecs/README.md schema vocabulary table.',
  );
  process.exit(1);
}

console.log(
  '[check-no-entity-array-literal] OK — legacy entity[] string literal ' +
    'absent from packages/ apps/ templates/ live code.',
);
