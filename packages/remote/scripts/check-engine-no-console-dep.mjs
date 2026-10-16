#!/usr/bin/env node
// AC-09 + AC-22: dual bundle-physical-isolation gate (forward direction +
// runtime bundle direction). Asserts:
//
//   (a) packages/runtime/package.json#dependencies + devDependencies +
//       peerDependencies do NOT list '@forgeax/engine-remote' (AC-22). This is
//       the declarative isolation - engine never names the console
//       package as a static dep; consumption is exclusively via dynamic
//       `await import('@forgeax/engine-remote/server')` at runtime inside
//       Renderer.startConsole(opts) (D-P4 + plan-strategy 1).
//
//   (b) packages/runtime/dist/** runtime bundle (*.mjs + *.js, excluding
//       *.d.ts type declarations) does NOT contain the literal
//       '@forgeax/engine-remote' string (AC-09). Type-only imports may keep
//       the string inside .d.ts payloads but are stripped from runtime
//       bundles; this gate guards against accidental static `import
//       '@forgeax/engine-remote/server'` introduction that would force AI users
//       to download the console payload even when startConsole() is
//       never called (charter proposition 4 explicit opt-in).
//
// Pattern aligns with scripts/check-shader-runtime-deps.mjs +
// scripts/check-shader-no-naga-in-dist.mjs - zero npm deps, plain node
// stdio, exit non-zero on hit. The AIUser F-3 P3 merge AC adds a peer
// script (check-console-not-in-engine-bundle.mjs) that runs the same (b)
// check from a separate entry so CI can wire either / both.
//
// feat-20260517 M2 audit (w23): no surface change. The console subsystem
// stayed dynamic-import-only on the engine side; the inspect-subcommand
// removal happened entirely inside the console package. Companion gate
// check-no-ecs-literal-residue.mjs covers the new ECS_ONLY literal check.
//
// feat-20260513-console-typed-sugar-and-injection M5 / w22 sanity:
// the add-only `./defineSugar` + `./injectSystem` sub-entries (declared
// under @forgeax/engine-remote package.json#exports) do NOT introduce a
// new physical dep into packages/runtime/* — engine -> console remains a
// dynamic `await import('@forgeax/engine-remote/server')` only path.
// This gate has been re-run post-w17 with 0 hits in (a) + (b); the new
// sub-entries widen the console surface without piercing the isolation.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const CONSOLE_DEP = '@forgeax/engine-remote';
const ENGINE_PKG = process.argv[2] ?? 'packages/runtime/package.json';
const ENGINE_DIST = process.argv[3] ?? 'packages/runtime/dist';
const RUNTIME_EXTS = new Set(['.js', '.mjs', '.cjs']);
const SEGMENTS = ['dependencies', 'devDependencies', 'peerDependencies'];

// AC-16 (feat-20260516-console-dependency-inversion w6a): runtime grep is
// extended past the bare `@forgeax/engine-remote` package literal. After M5
// removed `Renderer.startConsole` + `StartConsoleOptions` + `ConsoleHandle`
// + `EngineInspectorError` shell types from runtime sources, these literals
// must never reappear in `packages/runtime/dist/**` (the load-bearing
// runtime bundle AI users download). `@forgeax/engine-types` is the SSOT
// for Registry + 6-member InspectorErrorCode and is intentionally exempt —
// runtime/types share the types layer but must not name console-runtime
// concepts. Scope is dist-only by design (test-d files in src reference
// the names to *assert absence* via `@ts-expect-error`; JSDoc comments may
// cross-reference for context — both are stripped from dist).
const CONSOLE_NAMED_LEAKS = ['ConsoleHandle', 'StartConsoleOptions', 'InspectorError'];

const failures = [];

// (a) engine package.json deps three-segment grep
try {
  const pkg = JSON.parse(readFileSync(ENGINE_PKG, 'utf8'));
  for (const seg of SEGMENTS) {
    const obj = pkg[seg];
    if (typeof obj !== 'object' || obj === null) continue;
    if (CONSOLE_DEP in obj) {
      failures.push({
        kind: 'package-dep',
        location: `${ENGINE_PKG}#${seg}.${CONSOLE_DEP}`,
        hint: `remove ${CONSOLE_DEP} from ${seg}; engine consumes console via dynamic import('@forgeax/engine-remote/server') inside Renderer.startConsole(opts), per D-P4 bundle physical isolation`,
      });
    }
  }
} catch (e) {
  failures.push({
    kind: 'package-read-error',
    location: ENGINE_PKG,
    hint: `failed to parse ${ENGINE_PKG}: ${e instanceof Error ? e.message : String(e)}`,
  });
}

// (b) engine dist runtime bundle grep
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    if (p.endsWith('.d.ts') || p.endsWith('.d.mts') || p.endsWith('.d.cts')) continue;
    const ext = p.slice(p.lastIndexOf('.'));
    if (!RUNTIME_EXTS.has(ext)) continue;
    const text = readFileSync(p, 'utf8');
    if (text.includes(CONSOLE_DEP)) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(CONSOLE_DEP)) {
          failures.push({
            kind: 'bundle-hit',
            location: `${p}:${i + 1}`,
            hint: `${CONSOLE_DEP} must not appear in engine runtime bundle; convert to dynamic await import('@forgeax/engine-remote/server')`,
          });
        }
      }
    }
  }
}
walk(ENGINE_DIST);

// (c) AC-16 named-leak grep over runtime dist. After M5 removed
// `Renderer.startConsole` / `StartConsoleOptions` / `ConsoleHandle` /
// `EngineInspectorError` from runtime, these identifiers must stay gone
// from the runtime bundle that ships. Scope narrowed to ENGINE_DIST
// (excluding `.d.ts`) on purpose:
//   - test files (`__tests__/**`, `*.test-d.ts`, `*.test.ts`) live in src
//     and intentionally reference the names to *assert their absence*
//     (renderer.test-d.ts uses `// @ts-expect-error ConsoleHandle removed`);
//   - JSDoc comments in src may legitimately cite the names for context
//     (register-inspector.ts cross-references `InspectorError` from
//     `@forgeax/engine-types`); both are stripped from dist.
// Dist is the load-bearing artefact AI users download; if a literal
// survives compilation it means real code wired the console-shape name.
function walkNamedLeak(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walkNamedLeak(p);
      continue;
    }
    if (p.endsWith('.d.ts') || p.endsWith('.d.mts') || p.endsWith('.d.cts')) continue;
    const ext = p.slice(p.lastIndexOf('.'));
    if (!RUNTIME_EXTS.has(ext)) continue;
    const text = readFileSync(p, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const leak of CONSOLE_NAMED_LEAKS) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(leak)) {
          failures.push({
            kind: 'named-leak-hit',
            location: `${p}:${i + 1}`,
            hint: `${leak} must not appear in runtime dist after M5 dependency inversion (AC-16); console-shaped names belong in @forgeax/engine-remote (Registry/runtime) or @forgeax/engine-types (InspectorError 6-member union, types-only re-export)`,
          });
        }
      }
    }
  }
}
walkNamedLeak(ENGINE_DIST);

if (failures.length > 0) {
  process.stderr.write(
    `[reason] AC-09 + AC-22 + AC-16 FAIL: ${CONSOLE_DEP} or named leaks (${CONSOLE_NAMED_LEAKS.join(', ')}) appear in ${ENGINE_PKG} / ${ENGINE_DIST}/**\n`,
  );
  process.stderr.write('[rerun]  node packages/remote/scripts/check-engine-no-console-dep.mjs\n');
  process.stderr.write('[hint]   bundle physical isolation guard - violations:\n');
  for (const f of failures) {
    process.stderr.write(`  ${f.kind}: ${f.location}\n    -> ${f.hint}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `[ok] AC-09 + AC-22 + AC-16: ${ENGINE_PKG} three segments + ${ENGINE_DIST}/** runtime bundle clean of ${CONSOLE_DEP} and named leaks (${CONSOLE_NAMED_LEAKS.join(', ')})\n`,
);
