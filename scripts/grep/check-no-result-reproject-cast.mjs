#!/usr/bin/env node
// AC-06 / AC-07 (feat-small-20260516-result-err-reproject-cast-cleanup w2):
// permanent anti-pattern guard — assert that the dead reproject cast literal
// `as unknown as Result<` cannot re-appear in the live ECS source tree.
// `ResultErr<E>` is single-parameter (carries only the error type `E`, no
// success-branch `T`); after a `if (!r.ok) return r;` narrow the value
// structurally satisfies any `Result<X, E>` and can be returned directly
// without a re-projection cast.
//
// Banned pattern (regex; case-sensitive):
//   - the literal substring `as unknown as Result<` anywhere in source code
//
// Files scanned: TS / JS source under packages/ecs/src/ (decision D-3 keeps
// the scope aligned with requirements AC-06; rhi / naga stay out of scope).
// Markdown docs are not scanned (loop history retains historical mentions).
//
// Self-exempt:
//   - this gate file itself
//
// Pattern + zero-dep stdio mirrors scripts/grep/check-no-buffer-colon-keyword.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOTS = ['packages/ecs/src'];

const SELF_EXEMPT = new Set(['scripts/grep/check-no-result-reproject-cast.mjs']);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.cache', 'test-output']);

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

const RE_LITERAL = /as unknown as Result</g;

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
    '[check-no-result-reproject-cast] AC-06 violated: dead reproject cast ' +
      'literal `as unknown as Result<` re-appeared in source:',
  );
  for (const h of hits) {
    console.error(`  - ${h.literal}  in  ${h.path}`);
  }
  console.error('[rerun] pnpm grep:no-result-reproject-cast');
  console.error(
    '[hint] ResultErr<E> is single-parameter (no success-branch T); after ' +
      '`if (!r.ok) return r;` narrow, a bare `return record;` is enough — ' +
      'no `as unknown as Result<X, E>` reproject is needed. See ' +
      'packages/ecs/src/result.ts module docstring for the SSOT statement.',
  );
  process.exit(1);
}

console.log(
  '[check-no-result-reproject-cast] OK — dead reproject cast literal ' +
    '`as unknown as Result<` absent from packages/ecs/src/ live code.',
);
