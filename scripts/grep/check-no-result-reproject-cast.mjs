#!/usr/bin/env node
import process from 'node:process';
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
import { grepSourceFiles } from './source-files.mjs';

const ROOTS = ['packages/ecs/src'];

const SELF_EXEMPT = new Set(['scripts/grep/check-no-result-reproject-cast.mjs']);

const RE_LITERAL = /as unknown as Result</g;

const hits = [];

for (const { path: p, code: stripped } of grepSourceFiles(ROOTS, { exempt: SELF_EXEMPT })) {
  RE_LITERAL.lastIndex = 0;
  let m = RE_LITERAL.exec(stripped);
  while (m !== null) {
    hits.push({ path: p, literal: m[0] });
    m = RE_LITERAL.exec(stripped);
  }
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
