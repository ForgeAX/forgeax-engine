#!/usr/bin/env node
// count-math-exports.mjs - AST-based function counter (AC-03 surface >= 106).
//
// Uses the typescript compiler API to parse packages/math/src/**/*.ts and
// tallies the public `export function` count along with the per-namespace
// distribution. Filter rules:
//   - exclude _internal/** (D-P13: never leaves the package)
//   - exclude types.ts (pure types, no function exports)
//   - exclude __tests__/** (test files do not count toward surface)
//   - exclude index.ts (aggregate re-exports add no new functions)
//
// Output JSON: { totalCount, perNamespace, breakdown }
//   - totalCount: total function count across all namespaces (after dedup)
//   - perNamespace: { vec3: 8, mat4: 4, ... }
//   - breakdown: function-name list per namespace
//
// Anchors: requirements AC-03 surface >= 106; plan-strategy D-P10
// (AC-03 counting script via AST); M2 baseline self-test should report 17.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', 'src');

/** Recursively collect .ts files, filtering _internal / __tests__ / types.ts / index.ts. */
function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === '_internal' || name === '__tests__') continue;
      out.push(...collectFiles(full));
    } else if (name.endsWith('.ts')) {
      if (name === 'types.ts' || name === 'index.ts') continue;
      if (name.endsWith('.test-d.ts') || name.endsWith('.test.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

/** Collect names of `export function` and `export const = <fn-ref>` aliases via AST.
 *
 * Two forms supported:
 *   1. `export function foo() {}`          - direct function declaration
 *   2. `export const bar = foo;`           - function alias (plan-strategy S-1
 *      OQ-1 ruling: `mat4.transformPoint = transformVec3` also counts as surface)
 *
 * Not included: `export const X = <non-Identifier expression>` (objects /
 * literals / arrow functions). The math library has no such form today,
 * which keeps non-function surface from being miscounted.
 */
function collectExportedFunctions(file) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const names = [];
  for (const stmt of sf.statements) {
    const hasExport = stmt.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!hasExport) continue;

    // Form 1: export function foo() {}
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      names.push(stmt.name.text);
      continue;
    }

    // Form 2: export const bar = foo; (function alias; OQ-1 ruling)
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isIdentifier(decl.initializer)
        ) {
          names.push(decl.name.text);
        }
      }
    }
  }
  return names;
}

const files = collectFiles(SRC_ROOT);
const breakdown = {};
const perNamespace = {};
let totalCount = 0;
for (const f of files.sort()) {
  const ns = basename(f).replace(/\.ts$/, '');
  const fns = collectExportedFunctions(f);
  if (fns.length === 0) continue;
  breakdown[ns] = fns;
  perNamespace[ns] = fns.length;
  totalCount += fns.length;
}

const result = {
  totalCount,
  perNamespace,
  breakdown,
  filesScanned: files.map((f) => relative(join(__dirname, '..'), f)),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
