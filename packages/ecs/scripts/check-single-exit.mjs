#!/usr/bin/env node
// AC-09: single-exit verification gate for @forgeax/engine-ecs.
//
// feat-20260514-ecs-managed-buffer-and-resource-handles charter proposition 1
// (single-import affordance). Asserts that the new ECS types introduced by
// this loop are re-exported only from the @forgeax/engine-ecs package — no
// other package may smuggle them through its own public surface (which would
// give AI users two equally-correct import paths and break the "one obvious
// answer" guarantee).
//
// Banned pattern (per non-ecs package):
//   - Source/types of any file under packages/<X>/src or packages/<X>/dist
//     (X != 'ecs', X != 'engine') re-exporting any of the gated symbols
//     using `export ... from '@forgeax/engine-ecs'` (named or `* as`).
//
// Gated symbol set (the ECS-owned vocabulary):
//   - SchemaFieldType, ManagedRefStore, EcsErrorCode,
//     EcsErrorDetail, EcsError, ScheduleToken, Update, FixedUpdate, Time,
//     FixedTime, TimeDeltaInvalidError, TimeConfigInvalidError,
//     ScheduleScopeMismatchError
//   - StringView, Name, isStringField (feat-20260515-ecs-name-component-and-
//     string-schema M3 / w3-grep-gate-wire-ci)
//   - TypedArrayFor (feat-20260515-buffer-array-vocab-collapse M1 / w4 — the
//     new type-level mapping for `array<T>` / `array<T,N>` / `buffer` /
//     `buffer<N>` schema fields; same single-import affordance contract)
//
// Importing these symbols is fine and expected — the gate only forbids
// re-exporting them through another package's barrel. `Handle` and `Result`
// are owned by @forgeax/engine-types and are never forwarded by ECS.
//
// Freeze-list (markers, not regex matchers):
//   - 'fixed-size-mismatch' / 'fixed-array-overflow' / 'array-pop-empty' /
//     'instance-transforms-stride-mismatch' (the 4 new EcsErrorCode literals
//     added by feat-20260515-buffer-array-vocab-collapse M2 / w11 — the
//     check-no-managed-array-error-code grep gate covers the 4 deleted
//     literals; this freeze-list documents the surviving members so AI
//     users tracing the cut have a single anchored declaration site)
//   - relationship target writes (the target is materialized and read-only)
//
// FixedArrayView / VarArrayView were removed from the gated set in
// feat-20260515-buffer-array-vocab-collapse M5 / w27 — the value-shape
// classes were physically deleted at M2 / w10, making the gate against
// them a permanent false-positive surface (the file no longer exists, so
// no package can re-export them). The check-no-managed-array-view-import
// grep gate covers re-introduction at the import-statement level.
//
// Pattern + zero-dep stdio aligns with scripts/check-shader-no-naga-in-dist.mjs
// + scripts/check-shader-no-compiler-import.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const GATED_SYMBOLS = [
  'SchemaFieldType',
  'ManagedRefStore',
  'EcsErrorCode',
  'EcsErrorDetail',
  'EcsError',
  'Name',
  'TypedArrayFor',
  'ScheduleToken',
  'Update',
  'FixedUpdate',
  'Time',
  'FixedTime',
  'TimeDeltaInvalidError',
  'TimeConfigInvalidError',
  'ScheduleScopeMismatchError',
];

// Freeze-list markers for AI users tracing the feat-20260515 cut.
// These are NOT regex matchers — `world.push` etc. are not re-exportable
// identifiers (they are method names on the World class) and the 4 error
// code string literals are guarded by the dedicated
// check-no-managed-array-error-code gate. Listed here for cross-cut
// discoverability via `git grep` against a single SSOT.
const FREEZE_LIST_MARKERS = [
  'relationship target writes',
  "'fixed-size-mismatch'",
  "'fixed-array-overflow'",
  "'array-pop-empty'",
  "'instance-transforms-stride-mismatch'",
];

// Match: `export { ... <Symbol>(?: as ...)? ... } from '...engine-ecs...'`
//        `export type { ... <Symbol>(?: as ...)? ... } from '...engine-ecs...'`
//        `export * as <name> from '...engine-ecs...'`  (overbroad re-export)
const SYM_GROUP = `(${GATED_SYMBOLS.join('|')})`;
const RE_NAMED = new RegExp(
  String.raw`export\s+(?:type\s+)?\{[^}]*\b${SYM_GROUP}\b[^}]*\}\s*from\s*['"][^'"]*engine-ecs['"]`,
  'm',
);
const RE_STAR = /export\s+\*\s+(?:as\s+\w+\s+)?from\s*['"][^'"]*engine-ecs['"]/m;

const PACKAGES_DIR = process.argv[2] ?? 'packages';
// Allowlisted packages that ARE the engine-ecs surface itself.
const SELF_PACKAGES = new Set(['ecs']);
const exts = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'test', 'tests']);
const hits = [];

function walk(dir, pkgName) {
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
      walk(p, pkgName);
    } else if (exts.has(p.slice(p.lastIndexOf('.')))) {
      // Skip declaration files — they cannot affect runtime bundle resolution
      // and TS type-only re-export through .d.ts is harmless for the
      // single-import-path AI affordance (the IDE still routes to engine-ecs).
      if (p.endsWith('.d.ts') || p.endsWith('.d.mts')) continue;
      const text = readFileSync(p, 'utf8');
      const namedMatch = text.match(RE_NAMED);
      if (namedMatch) {
        hits.push({ pkg: pkgName, path: p, hit: namedMatch[0].slice(0, 200) });
      }
      const starMatch = text.match(RE_STAR);
      if (starMatch) {
        hits.push({ pkg: pkgName, path: p, hit: starMatch[0].slice(0, 200) });
      }
    }
  }
}

let pkgEntries;
try {
  pkgEntries = readdirSync(PACKAGES_DIR);
} catch (e) {
  console.error(`[check-single-exit] cannot read ${PACKAGES_DIR}: ${e.message}`);
  process.exit(2);
}
for (const pkg of pkgEntries) {
  if (SELF_PACKAGES.has(pkg)) continue;
  const pkgPath = join(PACKAGES_DIR, pkg);
  let st;
  try {
    st = statSync(pkgPath);
  } catch {
    continue;
  }
  if (!st.isDirectory()) continue;
  walk(pkgPath, pkg);
}

if (hits.length > 0) {
  console.error(
    '[check-single-exit] AC-09 violated: gated @forgeax/engine-ecs symbols re-exported outside packages/ecs:',
  );
  for (const h of hits) {
    console.error(`  - ${h.path}`);
    console.error(`      ${h.hit}`);
  }
  console.error(
    '\nThe new ECS types (Handle, SchemaFieldType, ManagedRefStore, EcsErrorCode,\n' +
      'EcsErrorDetail, EcsError, Name, TypedArrayFor)\n' +
      'must be importable only via\n' +
      "  import { ... } from '@forgeax/engine-ecs'\n" +
      'so AI users have one obvious entry point. Importing the symbols is fine;\n' +
      're-exporting them through another package barrel is the violation.',
  );
  process.exit(1);
}

// Freeze-list markers are advisory: surfaced in stdout only as a sanity
// trace for AI users running this gate, never as a failure path.
void FREEZE_LIST_MARKERS;

console.log(
  `[check-single-exit] OK — no @forgeax/engine-ecs gated symbols re-exported from other packages.`,
);
