#!/usr/bin/env node

// lint-internal: ts-morph powered D-internal coupling enforcement.
//
// Enforces four bidirectional rules between `_xxx` naming and `@internal`
// JSDoc tags across packages/*/src + apps/*/src TypeScript sources:
//
//   R-internal-B: class private/protected member name starts with _
//                 -> requires /** @internal */ JSDoc.
//   R-internal-C: class private/protected member has @internal
//                 -> name must start with _.
//   R-internal-D: module-level `let _xxx` -> requires @internal on the
//                 VariableStatement (not the VariableDeclaration).
//   R-internal-E: interface/type member name starts with _ -> requires
//                 field-level @internal (no cascade from interface itself,
//                 OOS-13).
//
// R-internal-A (private/protected name MUST NOT start with _) is owned by
// Biome `useNamingConvention` and is intentionally NOT duplicated here.
//
// CLI:
//   node scripts/lint-internal.mjs       # repo scan, exit 0/1
//
// Output (stderr): one line per error, formatted
//   [lint:internal] error: <file>:<line> <name>: <reason> (R-internal-<X>)
// followed by `<N> errors`.
//
// Exit codes: 0 clean, 1 errors found, 2 setup/load failure.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Project, SyntaxKind } from 'ts-morph';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const SOURCE_GLOBS = ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'];

function hasInternalTag(node) {
  if (typeof node.getJsDocs !== 'function') return false;
  for (const doc of node.getJsDocs()) {
    for (const tag of doc.getTags()) {
      if (tag.getTagName() === 'internal') return true;
    }
  }
  return false;
}

function startsWithUnderscore(name) {
  // Single _ only. Double `__` is brand / phantom-tag idiom (Biome's job).
  return typeof name === 'string' && name.length >= 2 && name[0] === '_' && name[1] !== '_';
}

function pushErr(errors, node, name, rule, reason) {
  const sourceFile = node.getSourceFile();
  errors.push({
    file: sourceFile.getFilePath(),
    line: node.getStartLineNumber(),
    name,
    rule,
    reason,
  });
}

function checkClassMember(member, errors) {
  const modifiers = member.getModifiers().map((m) => m.getText());
  const restricted = modifiers.includes('private') || modifiers.includes('protected');
  const name = member.getName();
  const underscored = startsWithUnderscore(name);
  const tagged = hasInternalTag(member);
  if (restricted && underscored && !tagged) {
    pushErr(errors, member, name, 'R-internal-B', '_ prefix without @internal JSDoc');
    return;
  }
  if (tagged && !underscored) {
    pushErr(errors, member, name, 'R-internal-C', '@internal without _ prefix');
  }
}

function checkInterfaceMember(member, errors) {
  const name = member.getName();
  if (!startsWithUnderscore(name)) return;
  if (hasInternalTag(member)) return;
  pushErr(
    errors,
    member,
    name,
    'R-internal-E',
    '_ prefix on interface/type member without field-level @internal (no cascade)',
  );
}

function checkModuleVariableStatement(statement, errors) {
  if (!statement.isExported && statement.getKind() !== SyntaxKind.VariableStatement) return;
  const declarationKind = statement.getDeclarationKind();
  if (declarationKind !== 'let') return;
  const declarations = statement.getDeclarations();
  if (declarations.length === 0) return;
  const first = declarations[0];
  const name = first.getName();
  if (!startsWithUnderscore(name)) return;
  if (hasInternalTag(statement)) return;
  pushErr(errors, statement, name, 'R-internal-D', 'module-level `let _xxx` without @internal');
}

export function lintProjectSource(project) {
  const errors = [];
  for (const sourceFile of project.getSourceFiles()) {
    for (const cls of sourceFile.getClasses()) {
      for (const prop of cls.getProperties()) checkClassMember(prop, errors);
      for (const method of cls.getMethods()) checkClassMember(method, errors);
    }
    for (const iface of sourceFile.getInterfaces()) {
      for (const prop of iface.getProperties()) checkInterfaceMember(prop, errors);
      for (const method of iface.getMethods()) checkInterfaceMember(method, errors);
    }
    for (const typeAlias of sourceFile.getTypeAliases()) {
      const literal = typeAlias.getTypeNodeOrThrow();
      if (literal.getKind() === SyntaxKind.TypeLiteral) {
        for (const prop of literal.getProperties()) checkInterfaceMember(prop, errors);
      }
    }
    for (const stmt of sourceFile.getVariableStatements()) {
      checkModuleVariableStatement(stmt, errors);
    }
  }
  return errors;
}

function main() {
  const tsconfig = resolve(REPO_ROOT, 'tsconfig.base.json');
  if (!existsSync(tsconfig)) {
    process.stderr.write(
      `[lint:internal] setup error: tsconfig.base.json not found at ${tsconfig}\n`,
    );
    process.exit(2);
  }
  const project = new Project({
    tsConfigFilePath: tsconfig,
    skipAddingFilesFromTsConfig: true,
  });
  for (const glob of SOURCE_GLOBS) {
    project.addSourceFilesAtPaths(resolve(REPO_ROOT, glob));
  }
  const errors = lintProjectSource(project);
  for (const e of errors) {
    const rel = e.file.replace(`${REPO_ROOT}/`, '');
    process.stderr.write(
      `[lint:internal] error: ${rel}:${e.line} ${e.name}: ${e.reason} (${e.rule})\n`,
    );
  }
  if (errors.length > 0) {
    process.stderr.write(`${errors.length} errors\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
