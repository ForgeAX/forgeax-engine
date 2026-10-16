#!/usr/bin/env node
// AC-01 + AC-02 + G1 reverse direction grep gate
// (feat-20260516-console-dependency-inversion w6b round 2 / plan-strategy
// section 2.10 + 2.6 function-injection):
// `@forgeax/engine-remote` must not depend on the renderer-side packages
// it serves. This is the machine implementation of the dependency
// inversion: console owns the abstractions (Registry interface lives in
// `@forgeax/engine-types`), renderer-side packages own the implementations,
// hosts compose the two via injection (`wireDefaultInspectors(reg, ctx,
// {registerEcsInspector, registerRuntimeInspector})`). Without this gate,
// the next person to import `@forgeax/engine-pack` inside console for
// "convenience" silently re-introduces the cycle that M3 just paid the
// cost to break (see plan-strategy section 2.7 / R-GREP-FALSE-NEG).
//
// Round 2 strict 4-deny-list: round 1 had to narrow the src+peerDeps
// scope to {pack,gltf} because wireDefaultInspectors value-imported
// register*Inspector from ecs+runtime. The function-injection refactor
// (w4wb-r2) eliminates the need; gate is now strict — all four
// @forgeax/engine-{runtime,ecs,pack,gltf} are forbidden in dependencies +
// peerDependencies + src + literals.
//
// feat-20260517 M2 audit (w23): the deny-list stays identical; the
// inspect-subcommand removal + Registry-injection refactor did not change
// the abstraction-side surface this gate guards (Registry interface lives
// in @forgeax/engine-types throughout). Companion gate
// check-no-ecs-literal-residue.mjs shipped alongside (AC-11) to guard
// against the deleted inspect-scripts.ts + 17-name MUTATION_BLACKLIST
// re-introduction.
//
// Four sources, scanned in order; ANY hit fails the gate fast:
//
//   (a) `packages/remote/package.json` — `dependencies` must contain 0 entry
//       of `@forgeax/engine-{runtime,ecs,pack,gltf}`. Only `@forgeax/engine-types`
//       is permitted (Registry interface SSOT + closed `InspectorErrorCode`
//       6-member union + `WireDefaultInspectorsInjectors` injection contract;
//       pure types, no runtime payload).
//
//   (b) `packages/remote/package.json` — `peerDependencies` must contain 0
//       entry of `@forgeax/engine-{runtime,ecs,pack,gltf}`. Function-injection
//       form means console no longer needs the `wireDefaultInspectors`
//       value-imports of register*Inspector — host imports them and passes
//       them in as the third argument (round 2 amendment, plan-strategy
//       section 2.6). All four packages are renderer-side capabilities that
//       compose into console only through the injection pathway, never as
//       library imports at any deps layer.
//
//   (c) `packages/remote/package.json` — `devDependencies` must also contain
//       0 entry of `@forgeax/engine-{runtime,ecs,pack,gltf}` (semantic
//       decoupling round, post-feat-20260516). Earlier rounds permitted
//       devDeps because they do not enter the published consumer-side
//       closure; the semantic-decoupling cut tightens the invariant to the
//       full deps surface so console is a pure inspector mechanism with 0
//       conceptual coupling to renderer-side packages. vitest fixtures
//       requiring real ecs / runtime / pack / gltf surfaces belong in
//       `apps/inspector-demo` or each capability owner's own `__tests__/`.
//
//   (d) `packages/remote/src/**/*.ts` — every ES `import '@forgeax/engine-X'`
//       (or `from '@forgeax/engine-X'`) where X in {runtime,ecs,pack,gltf} is
//       forbidden. CommonJS `require('@forgeax/engine-X')` is forbidden on
//       the same alphabet (defensive even though console is ESM-only).
//       `__tests__/` subtrees are excluded — they no longer pull renderer-
//       side packages after the semantic-decoupling cut, but the directory
//       remains skipped to keep test-only utility imports unconstrained.
//
//   (e) `packages/remote/src/**/*.ts` — any literal string containing
//       `@forgeax/engine-{runtime,ecs,pack,gltf}` is forbidden, regardless of
//       context. This catches the "string-split trick" reverse leak (e.g.
//       `await import('@forgeax/engine-' + 'pack')`) that an import-form-only
//       grep would miss (R-GREP-FALSE-NEG mitigation per plan-strategy
//       section 4 risks). Contextual exception: lines whose trimmed prefix
//       begins with `//` or `*` or `/*` are excluded (English-only block /
//       JSDoc comments describing the gate itself reference the names; the
//       gate would otherwise self-trigger on documentation).
//       `__tests__/` subtrees are excluded on the same rationale as (d).
//
// `@forgeax/engine-types` is the single permitted import target — it
// carries the Registry abstraction console implements + the
// WireDefaultInspectorsInjectors function contract. Pattern aligns with
// `check-engine-no-console-dep.mjs` — zero npm deps, plain node stdio,
// exit non-zero on hit, structured `[reason]/[rerun]/[hint]` stderr
// triple.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const CONSOLE_PKG = process.argv[2] ?? 'packages/remote/package.json';
const CONSOLE_SRC = process.argv[3] ?? 'packages/remote/src';

// Round 2 strict 4-deny-list: same alphabet across deps + peerDeps + src +
// literal layers. Function-injection form (w4wb-r2) means console never
// value-imports any of these packages; the host wires them in.
const DENY_SLUGS = ['runtime', 'ecs', 'pack', 'gltf'];

// Source-level deny-list (sources c + d): any of these strings appearing in
// a non-comment line under packages/remote/src/** is a hit. ESM `import`
// + CJS `require` + bare-literal occurrences all collapse to substring
// presence; the literal form is the wire identity that even string-split
// reconstructions converge on (R-GREP-FALSE-NEG mitigation per plan-strategy
// section 4 risks).
const SRC_DENY_LITERALS = DENY_SLUGS.map((slug) => `@forgeax/engine-${slug}`);

const SOURCE_EXTS = new Set(['.ts', '.mts', '.cts']);

const failures = [];

// (a) + (b) + (c) package.json deps + peerDeps + devDeps grep
let pkg;
try {
  pkg = JSON.parse(readFileSync(CONSOLE_PKG, 'utf8'));
} catch (e) {
  failures.push({
    kind: 'package-read-error',
    location: CONSOLE_PKG,
    hint: `failed to parse ${CONSOLE_PKG}: ${e instanceof Error ? e.message : String(e)}`,
  });
}

if (pkg) {
  const depsObj = pkg.dependencies ?? {};
  for (const slug of DENY_SLUGS) {
    const name = `@forgeax/engine-${slug}`;
    if (name in depsObj) {
      failures.push({
        kind: 'pkg-deps-hit',
        location: `${CONSOLE_PKG}#dependencies.${name}`,
        hint: `remove ${name} from #dependencies; console depends only on @forgeax/engine-types (Registry + WireDefaultInspectorsInjectors SSOT). renderer-side packages compose into console via host-side wireDefaultInspectors(reg, ctx, {registerEcsInspector, registerRuntimeInspector}) injection`,
      });
    }
  }
  const peerObj = pkg.peerDependencies ?? {};
  for (const slug of DENY_SLUGS) {
    const name = `@forgeax/engine-${slug}`;
    if (name in peerObj) {
      failures.push({
        kind: 'pkg-peer-hit',
        location: `${CONSOLE_PKG}#peerDependencies.${name}`,
        hint: `remove ${name} from #peerDependencies; round 2 function-injection (w4wb-r2) means console never value-imports register*Inspector — host injects via wireDefaultInspectors third argument. pack/gltf are also kubectl 4th-path plugin bins, never library imports`,
      });
    }
  }
  const devObj = pkg.devDependencies ?? {};
  for (const slug of DENY_SLUGS) {
    const name = `@forgeax/engine-${slug}`;
    if (name in devObj) {
      failures.push({
        kind: 'pkg-dev-hit',
        location: `${CONSOLE_PKG}#devDependencies.${name}`,
        hint: `remove ${name} from #devDependencies; console must contain 0 occurrence of @forgeax/engine-{runtime,ecs,pack,gltf} at any deps layer (semantic decoupling — console is a pure inspector mechanism that knows nothing about renderer-side concepts). vitest fixtures requiring real renderer-side surfaces belong in apps/inspector-demo or each capability owner's own __tests__`,
      });
    }
  }
}

// (d) + (e) source-tree grep over packages/remote/src/**/*.ts
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function walkSrc(dir) {
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
      // Skip __tests__ subtrees — vitest fixtures legitimately consume
      // real ecs / runtime / pack / gltf surfaces as devDeps; these
      // never enter the production bundle. The gate scopes to the
      // runtime dependency closure of the published package.
      if (name === '__tests__') continue;
      walkSrc(p);
      continue;
    }
    const ext = p.slice(p.lastIndexOf('.'));
    if (!SOURCE_EXTS.has(ext)) continue;
    if (p.endsWith('.d.ts') || p.endsWith('.d.mts') || p.endsWith('.d.cts')) continue;
    // Also skip `.test.ts` / `.spec.ts` siblings that may live outside a
    // `__tests__/` folder; same rationale as the directory-level skip.
    if (p.endsWith('.test.ts') || p.endsWith('.spec.ts')) continue;
    const text = readFileSync(p, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      for (const literal of SRC_DENY_LITERALS) {
        if (line.includes(literal)) {
          failures.push({
            kind: 'src-literal-hit',
            location: `${p}:${i + 1}`,
            hint: `remove '${literal}' from console source; round 2 strict 4-deny-list — register*Inspector flows in via wireDefaultInspectors injection (host-supplied), not static imports. plugin bins (pack/gltf) discover over PATH (kubectl 4th-path). string-split reconstructions are equally forbidden — the dependency-inversion contract is one-directional (plan-strategy section 2.10 + R-GREP-FALSE-NEG)`,
          });
        }
      }
    }
  }
}
walkSrc(CONSOLE_SRC);

if (failures.length > 0) {
  process.stderr.write(
    `[reason] AC-01 + AC-02 + G1 FAIL: console package depends on renderer-side packages it serves\n`,
  );
  process.stderr.write(
    '[rerun]  node packages/remote/scripts/check-console-not-import-engine.mjs\n',
  );
  process.stderr.write('[hint]   dependency inversion guard - violations:\n');
  for (const f of failures) {
    process.stderr.write(`  ${f.kind}: ${f.location}\n    -> ${f.hint}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `[ok] AC-01 + AC-02 + G1: ${CONSOLE_PKG} #dependencies + #peerDependencies + #devDependencies clean of @forgeax/engine-{${DENY_SLUGS.join(',')}}; ${CONSOLE_SRC}/** clean of @forgeax/engine-{${DENY_SLUGS.join(',')}}\n`,
);
