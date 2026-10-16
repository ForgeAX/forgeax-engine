#!/usr/bin/env node
// AC-10 / w26 (feat-20260515-buffer-array-vocab-collapse M5): assert that
// the 4 deleted `EcsErrorCode` members from feat-20260514's
// `managed-array-*` family cannot re-appear as string literals in the
// live source tree. The 4 deleted codes were retired at M2 / w11:
//
//   - 'managed-array-index-out-of-bounds'
//   - 'managed-array-pop-empty'
//   - 'managed-array-shrink-not-supported'
//   - 'managed-array-stride-mismatch'
//
// The 5th member of the family — `'managed-array-element-type-not-allowed'`
// — was kept (it routes from `defineComponent` schema-parser element-type
// validation, not from the deleted view-class set/get/push/pop runtime
// path). The substring `managed-array-` therefore cannot be used as a
// blanket banned token; the gate matches the 4 full literals only.
//
// Banned patterns (regex; case-sensitive; quoted forms only):
//   - 'managed-array-index-out-of-bounds'
//   - 'managed-array-pop-empty'
//   - 'managed-array-shrink-not-supported'
//   - 'managed-array-stride-mismatch'
//
// Files scanned: TS / JS source under packages/ + apps/ + templates/.
// Markdown docs are not scanned (READMEs retain historical mentions);
// .forgeax-harness/ history is exempt by virtue of not being scanned.
//
// Self-exempt:
//   - this gate file (banned set quoted in header for readability)
//   - packages/ecs/src/__tests__/buffer-array-errors.test.ts (the AC-07
//     test file carries `@ts-expect-error` anchors that intentionally
//     write the 4 deleted literals to lock the closed-union narrowing)
//   - packages/ecs/src/__tests__/managed-array-stride.test.ts (the
//     ECS-layer negative-invariant test asserts that the deleted
//     `'managed-array-stride-mismatch'` code is never routed by the
//     post-collapse write path; the literal must be present to filter
//     the collected error stream)
//   - packages/runtime/src/__tests__/instances.test.ts (carries the
//     same negative-invariant filter against the deleted literal)
//
// Pattern + zero-dep stdio mirrors scripts/grep/check-no-entity-array-literal.mjs
// + scripts/grep/check-asset-registry-instanced-removed.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const BANNED = [
  'managed-array-index-out-of-bounds',
  'managed-array-pop-empty',
  'managed-array-shrink-not-supported',
  'managed-array-stride-mismatch',
];

const ROOTS = ['packages', 'apps', 'templates'];

const SELF_EXEMPT = new Set([
  'scripts/grep/check-no-managed-array-error-code.mjs',
  'packages/ecs/src/__tests__/buffer-array-errors.test.ts',
  'packages/ecs/src/__tests__/managed-array-stride.test.ts',
  'packages/runtime/src/__tests__/instances.test.ts',
  // feat-20260609 M3+M5 merged the 3 exempt sources above into these consolidated files;
  // the @ts-expect-error negative-invariant fixtures carry forward intentionally.
  'packages/ecs/src/__tests__/errors.unit.test.ts',
  'packages/ecs/src/__tests__/serialization.unit.test.ts',
  'packages/runtime/src/__tests__/geometry.unit.test.ts',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.cache', 'test-output']);

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

// Build one alternation regex matching any quoted form of the 4 banned
// literals. The closing quote must match the opening quote (back-reference).
const ALT = BANNED.map((s) => s.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
const RE_LITERAL = new RegExp(`(['"\`])(?:${ALT})\\1`, 'g');

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
    '[check-no-managed-array-error-code] AC-10 violated: deleted ' +
      'EcsErrorCode literals re-appeared in non-comment source:',
  );
  for (const h of hits) {
    console.error(`  - ${h.literal}  in  ${h.path}`);
  }
  console.error(
    '\nfeat-20260515-buffer-array-vocab-collapse M2 / w11 deleted 4 ' +
      'members of the `managed-array-*` family from `EcsErrorCode`. ' +
      'The replacements are: `fixed-size-mismatch` (buffer<N> set with ' +
      'wrong byteLength) / `fixed-array-overflow` (array<T,N> push at ' +
      'capacity) / `array-pop-empty` (pop from empty array) / ' +
      '`instance-transforms-stride-mismatch` (RenderSystem entry stride ' +
      'defensive). The 5th member `managed-array-element-type-not-allowed` ' +
      'is kept (defineComponent schema parser). See AGENTS.md §Error model ' +
      '+ packages/ecs/README.md error code reverse anchors.',
  );
  process.exit(1);
}

console.log(
  '[check-no-managed-array-error-code] OK — deleted managed-array-* ' +
    'EcsErrorCode literals absent from packages/ apps/ templates/ live code.',
);
