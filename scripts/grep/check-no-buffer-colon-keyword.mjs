#!/usr/bin/env node
import process from 'node:process';
// Retired byte-field colon syntax must not reappear in component declarations.
// Byte storage uses array<u8> and array<u8, N>.
//
// Banned pattern (regex; case-sensitive):
//   - 'buffer:<digits>'   (single-quoted string literal)
//   - "buffer:<digits>"   (double-quoted string literal)
//   - `buffer:<digits>`   (template literal)
//
// Files scanned: TS / JS source under packages/ + apps/ + templates/.
// Markdown docs are not scanned (they retain historical mentions of the
// migration); .forgeax-harness/ history is exempt by virtue of not being
// scanned.
//
// Self-exempt:
//   - this gate file
//   - packages/ecs/src/__tests__/component-fields.test-d.ts (the AC-01
//     `@ts-expect-error` negative anchor intentionally writes the literal
//     `'buffer:8'` to lock the closed-union narrowing)
//
// Pattern + zero-dep stdio mirrors scripts/grep/check-no-entity-array-literal.mjs.
import { grepSourceFiles } from './source-files.mjs';

const ROOTS = ['packages', 'apps', 'templates'];

const SELF_EXEMPT = new Set([
  'scripts/grep/check-no-buffer-colon-keyword.mjs',
  'packages/ecs/src/__tests__/component-fields.test-d.ts',
]);

const RE_LITERAL = /(['"`])buffer:[0-9]+\1/g;

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
    '[check-no-buffer-colon-keyword] AC-10 violated: legacy schema-vocab ' +
      "keyword 'buffer:<N>' re-appeared as a string literal in source:",
  );
  for (const h of hits) {
    console.error(`  - ${h.literal}  in  ${h.path}`);
  }
  console.error(
    'Use array<u8> for variable bytes or array<u8, N> for fixed bytes. ' +
      'Supply an explicit Uint8Array when the input represents raw bytes.',
  );
  process.exit(1);
}

console.log(
  '[check-no-buffer-colon-keyword] OK — legacy buffer:<N> string literal ' +
    'absent from packages/ apps/ templates/ live code.',
);
