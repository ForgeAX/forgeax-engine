#!/usr/bin/env node
// check-pack-error-detail-narrowed.mjs — AC-07 ts-morph lint gate (w19)
//
// Uses ts-morph to scan all .ts source files under packages/pack/src
// and packages/runtime/src. For every switch statement whose expression is
// (or contains) a reference to .code, it finds case clauses whose text
// matches /^'pack-[^']+':/ and then checks that:
//   (a) any PropertyAccessExpression on `.detail` inside that case body
//       is NOT preceded by an `as` type assertion (AsExpression wrapping it)
//   (b) there is no explicit `as PackErrorDetail` cast on a `.detail` access
//
// Exit 0 = all checked; no illegal type-cast on .detail in pack-xxx cases.
// Exit 1 = one or more violations found.
//
// Aligned with plan-strategy §D-5 + requirements §6.2 AC-07.

import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Resolve repo root relative to this file (packages/pack/scripts/)
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..', '..', '..');

// Lazy import ts-morph from the workspace node_modules
const tsMorphPath = join(REPO_ROOT, 'node_modules', 'ts-morph', 'dist', 'ts-morph.js');

let Project, SyntaxKind;
try {
  const mod = await import(tsMorphPath);
  Project = mod.Project;
  SyntaxKind = mod.ts.SyntaxKind;
} catch (e) {
  process.stderr.write(`[check-pack-error-detail-narrowed] cannot load ts-morph: ${e}\n`);
  process.exit(1);
}

const TSCONFIG = join(REPO_ROOT, 'tsconfig.json');
const SCAN_ROOTS = [
  join(REPO_ROOT, 'packages', 'pack', 'src'),
  join(REPO_ROOT, 'packages', 'runtime', 'src'),
];

const PACK_ERROR_CODE_RE = /^'pack-[^']+'$/;

const project = new Project({
  tsConfigFilePath: TSCONFIG,
  skipAddingFilesFromTsConfig: true,
  addFilesFromTsConfig: false,
});

// Add only the source files under the two scan roots
for (const root of SCAN_ROOTS) {
  project.addSourceFilesAtPaths(join(root, '**', '*.ts'));
}

const failures = [];

// feat-20260609 M4 merged the original src/__tests__/errors.test.ts (which used
// `(err.detail as { ... }).X` switch casts as a typedoc-style fixture for the
// 9-member exhaustive map) into packages/pack/src/__tests__/pack.unit.test.ts.
// The merged file already has @ts-nocheck on line 1; AC-07 narrowing intent
// is enforced on production sources only.
const EXEMPT_PATHS = new Set([
  'packages/pack/src/__tests__/pack.unit.test.ts',
]);

for (const sourceFile of project.getSourceFiles()) {
  const filePath = sourceFile.getFilePath();
  const relPath = filePath.startsWith(REPO_ROOT) ? filePath.slice(REPO_ROOT.length + 1) : filePath;
  if (EXEMPT_PATHS.has(relPath)) continue;

  // Find all switch statements in the file
  const switchStatements = sourceFile.getDescendantsOfKind(SyntaxKind.SwitchStatement);

  for (const sw of switchStatements) {
    const expr = sw.getExpression();
    // Check if the switch expression text contains ".code" (e.g. err.code)
    if (!expr.getText().includes('.code')) continue;

    for (const caseClause of sw.getCaseBlock().getClauses()) {
      // Only CaseClause (not DefaultClause)
      if (caseClause.getKind() !== SyntaxKind.CaseClause) continue;
      const caseExpr = caseClause.getExpression();
      if (!caseExpr) continue;
      const caseText = caseExpr.getText().trim();

      // Only check pack-xxx case clauses
      if (!PACK_ERROR_CODE_RE.test(caseText)) continue;

      // Get all descendants of this case clause
      const descendants = caseClause.getDescendants();

      for (const node of descendants) {
        // Look for AsExpression (type assertion `expr as T`)
        if (node.getKind() === SyntaxKind.AsExpression) {
          const text = node.getText();
          // Flag if it's an "as"-cast on a .detail access
          if (text.includes('.detail')) {
            failures.push({
              file: filePath,
              line: node.getStartLineNumber(),
              caseCode: caseText,
              text: text.slice(0, 120),
              hint:
                'use switch (err.code) narrowing — the discriminated union narrows .detail automatically; no "as" cast needed',
            });
          }
        }

        // Also flag TypeAssertionExpression (<T>expr syntax)
        if (node.getKind() === SyntaxKind.TypeAssertionExpression) {
          const text = node.getText();
          if (text.includes('.detail')) {
            failures.push({
              file: filePath,
              line: node.getStartLineNumber(),
              caseCode: caseText,
              text: text.slice(0, 120),
              hint:
                'use switch (err.code) narrowing — angle-bracket cast on .detail is not needed; discriminated union narrows automatically',
            });
          }
        }
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `[check-pack-error-detail-narrowed] FAIL: ${failures.length} violation(s) found\n`,
  );
  process.stderr.write(
    '[hint] Each pack-xxx case must narrow .detail via switch discriminant, not via "as" cast\n',
  );
  for (const f of failures) {
    const rel = f.file.replace(REPO_ROOT + '/', '');
    process.stderr.write(`  ${rel}:${f.line} [case ${f.caseCode}]\n`);
    process.stderr.write(`    code: ${f.text}\n`);
    process.stderr.write(`    hint: ${f.hint}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `[ok] check-pack-error-detail-narrowed: no illegal type-cast on .detail in pack-xxx switch cases\n`,
);
