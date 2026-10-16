#!/usr/bin/env node
// AC-12 grep gate: @forgeax/engine-app must NOT export anything literally
// named `App` (reserved for the future ECS Component closure -- OOS-7
// spinoff in plan-strategy section 7) NOR register an ECS Component /
// Resource / Event under the literal name 'App'.
//
// Two assertions enforced (plan-tasks w16, requirements AC-12):
//
//   (a) Syntactic export ban -- regex scan of packages/app/src/**/*.ts.
//       The bans target VALUE-LEVEL exports that an ECS Component would
//       inhabit. Not target TYPE-LEVEL exports (`interface App` / `type
//       App = ...`): the canonical `App` handle interface lives in
//       `packages/app/src/types.ts` (plan-strategy section 3.1 line 158
//       + section 8.X line 299 SSOT) and is re-exported from index.ts.
//       The resolution here narrows AC-12 (a) literal regex list to the
//       value-level patterns plan-strategy actually intends to ban; the
//       AC-12 (b) ECS-registration-literal ban remains the primary
//       semantic gate (any ECS Component named 'App' is caught there
//       regardless of how its symbol is exported).
//
//       Banned value-level shapes:
//         - export const App<word-boundary>
//         - export class App<word-boundary>
//         - export function App<word-boundary>
//         - export default class App<word-boundary>
//         - export default function App<word-boundary>
//         - export { ... App ... }   (re-export of value-level App)
//         - export ... as App<word-boundary>
//
//   (b) ECS registration literal ban -- regex scan for `name: 'App'` /
//       `name: "App"` inside the same source tree, then context-filter
//       to a registration-call ancestor (defineComponent / registerComponent
//       / addEvent / insertResource / insertEvent / registerResource /
//       registerEvent).
//
// Why both (a) and (b)?
//   The prior loop (feat-20260512 onwards) standardised closed-union
//   error-code grep gates that scan exported identifiers; that gate
//   alone misses the case where someone registers a Component without
//   exporting it (path b). The ECS registry stores components by name
//   string, so a component named 'App' would collide with the future
//   reserved name even if no symbol is exported. Path (b) catches that.
//
// Usage:
//   node scripts/check-app-package-no-component.mjs
//     -> default scan of packages/app/src/**/*.ts; exits non-zero on
//        any hit, writes a structured hint to stderr.
//   node scripts/check-app-package-no-component.mjs <path1> [path2 ...]
//     -> scan explicit files (used by the fixture counter-example test).
//
// Zero npm deps; stdlib only. Mirrors the layout of
// scripts/check-shader-runtime-deps.mjs and check-shader-no-naga-in-dist.mjs.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_ROOT = join(REPO_ROOT, 'packages/app/src');

// --- Path (a): syntactic export bans -----------------------------------------
//
// Each pattern matches a single line where the SOURCE file declares an
// export literally named `App`. The bans are intentionally narrow so
// the fixture (`packages/app/__tests__/fixtures/forbidden-app-component.ts`)
// can hand-craft each case and verify the gate trips on every shape.
//
// Type-level bans (`export interface App` / `export type App = ...`) are
// deliberately omitted: the canonical `App` handle interface lives in
// `packages/app/src/types.ts` (plan-strategy section 3.1 + section 8.X
// SSOT) and re-exports through index.ts; banning the type-level shape
// would forbid the documented-canonical handle name. ECS Components are
// value-level (defineComponent / class / const), so the ban list focuses
// on those shapes; path (b) catches any Component registration regardless
// of how its symbol is exported.
const SYNTACTIC_BANS = [
  { id: 'a1', re: /^\s*export\s+const\s+App\b/m, label: 'export const App' },
  { id: 'a2', re: /^\s*export\s+class\s+App\b/m, label: 'export class App' },
  { id: 'a3', re: /^\s*export\s+function\s+App\b/m, label: 'export function App' },
  {
    id: 'a4',
    re: /^\s*export\s+default\s+class\s+App\b/m,
    label: 'export default class App',
  },
  {
    id: 'a5',
    re: /^\s*export\s+default\s+function\s+App\b/m,
    label: 'export default function App',
  },
  // export { App } / export { App as ... }   (bare `App` token in an
  // export-list -- value-level re-export of an `App` symbol). This rule
  // intentionally fires on type-level export-lists too (`export type {
  // App, ... }`); the canonical type-level re-export of the `App` handle
  // interface from index.ts is the sole legitimate exception (allowlisted
  // by absolute path below) per the plan-strategy SSOT.
  {
    id: 'a8',
    re: /^\s*export\s+(?:type\s+)?\{\s*[^}]*\bApp\b[^}]*\}/m,
    label: 'export { ..., App, ... }',
  },
  // export { ... as App } / export { ... as App, ... }  (alias TO App).
  {
    id: 'a9',
    re: /^\s*export\s+(?:type\s+)?\{\s*[^}]*\bas\s+App\b[^}]*\}/m,
    label: 'export { ... as App ... }',
  },
];

// Allowlist for legitimate `export type { App }` / `export { App }` lines.
// Single legitimate carrier: the public barrel `packages/app/src/index.ts`
// re-exports the canonical `App` handle interface (plan-strategy 3.1 +
// 8.X). Allowlist match is by repository-relative path (POSIX separators
// to keep the rule cross-platform).
const A8_ALLOWLIST_PATHS = new Set(['packages/app/src/index.ts']);

// --- Path (b): ECS registration literal ban ---------------------------------
//
// Spec phase: grep for `name: 'App'` / `name: "App"` and confirm the
// surrounding 200-char window contains a registration call.
const REGISTER_CONTEXT_RE =
  /\b(defineComponent|registerComponent|addEvent|insertResource|insertEvent|registerResource|registerEvent)\s*\(/;
const NAME_APP_LITERAL_RE = /\bname\s*:\s*['"]App['"]/g;

function listTsFilesRecursive(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch (_e) {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      let st;
      try {
        st = statSync(p);
      } catch (_e) {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
        walk(p);
      } else if (st.isFile() && entry.endsWith('.ts')) {
        out.push(p);
      }
    }
  }
  walk(root);
  return out;
}

function scanFile(absPath) {
  const text = readFileSync(absPath, 'utf8');
  const relPath = relative(REPO_ROOT, absPath).split('\\').join('/');
  const hits = [];

  for (const ban of SYNTACTIC_BANS) {
    // a8 / a9 allowlist for the canonical `App` handle re-export from
    // packages/app/src/index.ts (plan-strategy section 3.1 + 8.X SSOT).
    if ((ban.id === 'a8' || ban.id === 'a9') && A8_ALLOWLIST_PATHS.has(relPath)) {
      continue;
    }
    const m = ban.re.exec(text);
    if (m !== null) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const lineEnd = text.indexOf('\n', m.index);
      const lineNo = text.slice(0, m.index).split('\n').length;
      const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
      hits.push({
        path: 'a',
        banId: ban.id,
        label: ban.label,
        lineNo,
        snippet: lineText,
      });
    }
  }

  // Path (b): grep all `name: 'App'` literals, then context-filter.
  for (const m of text.matchAll(NAME_APP_LITERAL_RE)) {
    const idx = m.index ?? 0;
    // Look backwards 200 chars for a registration call. Single 200-char
    // window is a deliberate trade-off: full AST parse pulls in TS
    // dependencies; the lookback is large enough that the call paren
    // ahead of the property literal stays in window for typical
    // multi-line registration shapes. The fixture exercises the typical
    // shape directly; runtime drift on this heuristic is the sole cost.
    const windowStart = Math.max(0, idx - 200);
    const windowText = text.slice(windowStart, idx);
    if (REGISTER_CONTEXT_RE.test(windowText)) {
      const lineNo = text.slice(0, idx).split('\n').length;
      const lineStart = text.lastIndexOf('\n', idx) + 1;
      const lineEnd = text.indexOf('\n', idx);
      const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
      hits.push({
        path: 'b',
        banId: 'b1',
        label: "name: 'App' inside ECS registration call",
        lineNo,
        snippet: lineText,
      });
    }
  }

  return hits;
}

function main(argv) {
  const explicitFiles = argv.slice(2);
  const targets =
    explicitFiles.length > 0
      ? explicitFiles.map((p) => resolve(REPO_ROOT, p))
      : listTsFilesRecursive(DEFAULT_ROOT);

  const allHits = [];
  for (const f of targets) {
    const hits = scanFile(f);
    if (hits.length > 0) {
      for (const h of hits) {
        allHits.push({ file: f, ...h });
      }
    }
  }

  if (allHits.length === 0) {
    process.stdout.write(
      `AC-12 OK: no banned 'App' export or ECS registration literal in ${
        explicitFiles.length > 0
          ? `${targets.length} file(s)`
          : `${targets.length} file(s) under packages/app/src/**`
      }\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `AC-12 FAIL: 'App' name reserved for future ECS Component (OOS-7 spinoff in plan-strategy section 7); export / registration banned inside @forgeax/engine-app:\n`,
  );
  for (const h of allHits) {
    process.stderr.write(
      `  [${h.path}.${h.banId}] ${relative(REPO_ROOT, h.file)}:${h.lineNo} -- ${h.label}\n`,
    );
    process.stderr.write(`      ${h.snippet}\n`);
  }
  process.stderr.write(
    `[hint] rename the symbol; the literal 'App' is reserved for the future ECS Component single closure (plan-strategy section 7 OOS-7 spinoff)\n`,
  );
  process.exit(1);
}

main(process.argv);
