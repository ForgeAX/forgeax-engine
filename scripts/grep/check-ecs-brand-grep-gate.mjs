#!/usr/bin/env node
// feat-20260614-ecs-shared-component-and-unique-rename M1 / w3:
// post-rename grep gate for ECS brand + schema-vocab regressions.
//
// Bans 5 families of stale literal / identifier in live source:
//
//   1. `'managed'`    brand literal      — M1 renamed to `'unique'`
//   2. `'unmanaged'`  brand literal      — M1 renamed to `'shared'`
//   3. `'ref<...'`    schema vocab       — M1 renamed to `'unique<...>'`
//   4. `ManagedRef*`  class / error code — M2 renamed to `UniqueRef*`
//   5. `'handle<...'` schema vocab       — M5 deleted; use `'shared<...>'`
//      (pattern (5) ships with M5 / w26 once every component schema +
//      downstream consumer has migrated.)
//
// White-list (D-6 internal helpers — `managed` label retained as
// "ECS-tracked" semantic, NOT a stale rename target):
//
//   - `releaseManagedFieldOnRow`        (world.ts release dispatch)
//   - `releaseManagedRefsOnRow`         (alias delegate)
//   - `releaseManagedRefHandle`         (per-handle release)
//   - `isManagedField` / `isManagedBufferField` / `isManagedArrayField`
//   - `MANAGED_ARRAY_ELEMENT_TYPES`     (array element type set)
//   - `parseManagedArraySchema`         (schema parser)
//   - `managed-array-*`                 (error code family — also gated by
//     `scripts/grep/check-no-managed-array-error-code.mjs`)
//   - `ManagedColumnReader` / `__managed` (column-reader brand — internal
//     reader contract independent of the brand rename)
//
// Files scanned: TS / JS source under packages/*/src + apps/*/src +
// templates/*/src — i.e. live source only. Markdown / docs / decision
// logs / .forgeax-harness state are NOT scanned (R-7).
//
// Self-exempt:
//   - this gate file (banned literals quoted in header for readability)
//
// Output on hit: per-line `<path>:<line>: <pattern>  | <content>` plus a
// hint table mapping old → new for AI-agent sed fix.
//
// Pattern + walker shape mirrors scripts/check-rename-grep-gate.mjs +
// scripts/grep/check-no-managed-array-error-code.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

// ---- pattern (4) toggle: flipped to true by M2/w5 — feat-20260614 ships
// the ManagedRefStore -> UniqueRefStore rename + ManagedRef*Error -> UniqueRef*Error.
const ENABLE_MANAGED_REF_PATTERN = true;

// ---- white-list identifiers retained per D-6 (substrings containing
// `Managed` / `managed` that are NOT stale rename targets). The gate
// rewrites a line to remove these tokens before pattern matching, so the
// remainder of the line still gets checked for actual stale tokens.
const WHITELIST_IDENTIFIERS = [
  'releaseManagedFieldOnRow',
  'releaseManagedRefsOnRow',
  'releaseManagedRefHandle',
  'isManagedField',
  'isManagedBufferField',
  'isManagedArrayField',
  'MANAGED_ARRAY_ELEMENT_TYPES',
  'parseManagedArraySchema',
  'ManagedColumnReader',
  '__managed',
  'managed-array-',
];

// ---- pattern definitions
//
// (1)+(2) brand literal `'managed'` / `"managed"` / `'unmanaged'` /
// `"unmanaged"` — single- or double-quoted runtime literal. Backticks NOT
// matched: backtick `\`managed\`` is exclusively JSDoc / comment markup
// in this codebase (template literal types use `\`unique\`` / `\`shared\``
// only after rename); quoted-with-quote forms are the only runtime brand
// the type system reads.
const RE_BRAND_MANAGED = /(['"])managed\1/g;
const RE_BRAND_UNMANAGED = /(['"])unmanaged\1/g;
// (3) schema vocab — single- or double-quoted string starting with `ref<`.
// Same reasoning: only quoted forms are runtime schema strings.
const RE_VOCAB_REF = /(['"])ref<[^'"]*\1/g;
// (4) ManagedRef class / error code identifier — word-boundary, not part
// of a whitelist token (whitelist applied first via line rewrite)
const RE_MANAGED_REF = /\bManagedRef\w*/g;
// (5) schema vocab — single- or double-quoted string starting with `handle<`.
// feat-20260614 M5 / w23+w26: the 'handle<T>' parser arm was deleted; any
// remaining literal in live source is a stale rename target. The
// SchemaUnsupportedFieldError migration hint in packages/ecs/src/errors.ts
// embeds the literal `'handle<${tag}>'` template — that file is exempted
// via `EXEMPT_FILES` below.
const RE_VOCAB_HANDLE = /(['"])handle<[^'"]*\1/g;
// (6) global `onLastRelease(globalCb)` listener call — deleted in
// feat-20260614 M6 / D-10. The release signal is now the per-handle deleter
// passed as the THIRD argument to `alloc(target, payload, onLastRelease?)`,
// which is a parameter name (no leading `.`) and therefore not matched here.
// This pattern matches only the deleted global broadcast call site
// `<expr>.onLastRelease(` (e.g. `store.onLastRelease(cb)` /
// `world.sharedRefs.onLastRelease((h, t) => ...)`).
const RE_GLOBAL_ON_LAST_RELEASE = /\.onLastRelease\s*\(/g;
// (6b) the deleted `lastReleaseListeners` Set field (D-10).
const RE_LAST_RELEASE_LISTENERS = /lastReleaseListeners/g;

const ROOTS = ['packages', 'apps', 'templates'];

const SELF_EXEMPT = new Set(['scripts/grep/check-ecs-brand-grep-gate.mjs']);

// Files exempted from pattern (5) only — they legitimately reference the
// retired `'handle<...>'` literal in source comments / migration hints, or in
// `it(...)` description strings of negative rejection tests. Pattern (1)-(4)
// still apply.
//
// The two `__tests__` entries are negative-path fixtures that assert the
// retired keyword is rejected at runtime; the literal lives in the `it(...)`
// description string (a whole-test exemption is more robust than a per-line
// `// gate-allow:ecs-brand` marker, which biome's formatter relocates when it
// reflows the long description line — feat-20260614 M9 / w40).
const EXEMPT_HANDLE_PATTERN = new Set([
  'packages/ecs/src/errors.ts',
  'packages/ecs/src/__tests__/deprecated-vocab-rejection.unit.test.ts',
  'packages/ecs/src/__tests__/serialization.unit.test.ts',
]);

// Files exempted from pattern (3) only — same reasoning, errors.ts embeds
// the retired `'ref<${tag}>'` literal in the SchemaUnsupportedFieldError
// migration hint (M1 rename target); the rejection fixture asserts `'ref<T>'`
// is rejected. Pattern (1), (2), (4), (5) still apply.
const EXEMPT_REF_PATTERN = new Set([
  'packages/ecs/src/errors.ts',
  'packages/ecs/src/__tests__/deprecated-vocab-rejection.unit.test.ts',
]);

// Per-line opt-out: lines containing the marker comment
// `// gate-allow:ecs-brand` are skipped. Use sparingly — this is for test
// fixtures that intentionally write old vocab to verify rejection paths
// (e.g. `'array<ref<X>>'` w12 illegal-element-type-not-allowed test).
const GATE_ALLOW_MARKER = 'gate-allow:ecs-brand';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.cache', 'test-output']);

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

// Only scan files whose path matches `<root>/<pkg>/src/...` — apps are
// nested (apps/hello/<demo>/src/...) so the predicate is "any segment is
// 'src' AND a parent segment is one of ROOTS".
function isLiveSource(relPath) {
  const parts = relPath.split(sep);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'src') {
      // require a ROOTS segment before the 'src' segment
      for (let j = 0; j < i; j++) {
        if (ROOTS.includes(parts[j])) return true;
      }
    }
  }
  return false;
}

function stripLineComments(line) {
  // Strip JSDoc / line comments (`// ...`, leading ` * ...`); keep
  // string-quoted regions intact. Heuristic: if a `//` appears outside any
  // single/double-quoted span, drop the rest of the line. Block comments
  // are stripped at the file level via stripBlockComments.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (!inSingle && !inDouble && c === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
    if (!inDouble && c === "'") inSingle = !inSingle;
    if (!inSingle && c === '"') inDouble = !inDouble;
    if (c === '\\') i++; // skip escape next
  }
  return line;
}

function rewriteLineWhitelist(line) {
  let out = line;
  for (const id of WHITELIST_IDENTIFIERS) {
    if (out.includes(id)) {
      out = out.split(id).join(''); // erase token; remainder still matches
    }
  }
  return out;
}

function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

const hits = [];

function scan(path, relPath) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  // strip /* ... */ first, then strip // ... per line
  const noBlock = stripBlockComments(text);
  const lines = noBlock.split('\n');
  // also keep raw lines so we can show original content in the hit message
  const rawLines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNoBlock = lines[i] ?? '';
    const raw = rawLines[i] ?? '';
    if (raw.includes(GATE_ALLOW_MARKER)) continue;
    const noLine = stripLineComments(lineNoBlock);
    const stripped = rewriteLineWhitelist(noLine);

    const handlePatternRow = EXEMPT_HANDLE_PATTERN.has(relPath)
      ? []
      : [[RE_VOCAB_HANDLE, "'handle<...' schema vocab literal (deleted in feat-20260614 M5)"]];
    const refPatternRow = EXEMPT_REF_PATTERN.has(relPath)
      ? []
      : [[RE_VOCAB_REF, "'ref<...' schema vocab literal"]];
    for (const [re, label] of [
      [RE_BRAND_MANAGED, "'managed' brand literal"],
      [RE_BRAND_UNMANAGED, "'unmanaged' brand literal"],
      ...refPatternRow,
      ...(ENABLE_MANAGED_REF_PATTERN ? [[RE_MANAGED_REF, 'ManagedRef* identifier']] : []),
      ...handlePatternRow,
      [
        RE_GLOBAL_ON_LAST_RELEASE,
        'global .onLastRelease( listener call (deleted feat-20260614 M6 D-10; use per-handle deleter)',
      ],
      [RE_LAST_RELEASE_LISTENERS, 'lastReleaseListeners field (deleted feat-20260614 M6 D-10)'],
    ]) {
      re.lastIndex = 0;
      let m = re.exec(stripped);
      while (m !== null) {
        hits.push({ path: relPath, line: i + 1, hit: m[0], label, content: raw.trim() });
        m = re.exec(stripped);
      }
    }
  }
}

function walk(dir, relRoot) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const rel = relative(relRoot, p);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(p, relRoot);
      continue;
    }
    const ext = p.slice(p.lastIndexOf('.'));
    if (!CODE_EXTS.has(ext)) continue;
    if (SELF_EXEMPT.has(rel)) continue;
    if (!isLiveSource(rel)) continue;
    scan(p, rel);
  }
}

const repoRoot = process.cwd();
for (const root of ROOTS) {
  walk(join(repoRoot, root), repoRoot);
}

if (hits.length > 0) {
  console.error(
    `[check-ecs-brand-grep-gate] FAIL — ${hits.length} stale brand/vocab literal hit(s) in live source:`,
  );
  for (const h of hits) {
    console.error(`  ${h.path}:${h.line}: ${h.label}  |  ${h.content}`);
  }
  console.error('\n[hint] rename map (feat-20260614 M1):');
  console.error("  'managed'   ->  'unique'   (Handle brand mode literal)");
  console.error("  'unmanaged' ->  'shared'   (Handle brand mode literal)");
  console.error("  'ref<X>'    ->  'unique<X>'  (component schema vocab keyword)");
  console.error('  ManagedHandle<T>   ->  UniqueHandle<T>');
  console.error('  UnmanagedHandle<T> ->  SharedHandle<T>');
  console.error('  toManaged<T>(raw)  ->  toUnique<T>(raw)');
  console.error('  toUnmanaged<T>(raw) ->  toShared<T>(raw)');
  if (ENABLE_MANAGED_REF_PATTERN) {
    console.error('  ManagedRefStore             ->  UniqueRefStore       (M2)');
    console.error('  ManagedRefReleasedError     ->  UniqueRefReleasedError    (M2)');
    console.error('  ManagedRefDoubleReleaseError ->  UniqueRefDoubleReleaseError (M2)');
    console.error('  managed-ref-*  error codes  ->  unique-ref-* (M2)');
  }
  console.error("  'handle<X>' schema vocab    ->  'shared<X>' (feat-20260614 M5)");
  console.error(
    '  store.onLastRelease(cb)     ->  alloc(target, payload, onLastRelease) third argument (per-handle deleter, feat-20260614 M6 D-10)',
  );
  console.error('  lastReleaseListeners field  ->  per-slot releaseCallbacks Map (M6 D-10)');
  console.error(
    '\nWhite-list (D-6 internal helpers — keep `managed` label as "ECS-tracked" semantic):',
  );
  console.error(`  ${WHITELIST_IDENTIFIERS.join(', ')}`);
  process.exit(1);
}

console.log(
  `[check-ecs-brand-grep-gate] OK — 0 stale brand/vocab hits in live source under ${ROOTS.join(' / ')}.`,
);
