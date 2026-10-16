#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

const RUNTIME_FILE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const ENGINE_PACKAGE_ROOT = /^(@forgeax\/engine(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?)(?:\/|$)/;
const RUNTIME_DEPENDENCY_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies',
];

function packageNameFromSpecifier(specifier) {
  const match = ENGINE_PACKAGE_ROOT.exec(specifier);
  return match?.[1] ?? null;
}

export function extractRuntimeEngineImports(source) {
  const imports = [];
  const sourceFile = ts.createSourceFile(
    'package-runtime-dependencies.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  function addImport(node) {
    if (!ts.isStringLiteralLike(node)) return;
    const specifier = node.text;
    const dependency = packageNameFromSpecifier(specifier);
    if (dependency === null) return;
    imports.push({
      dependency,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      specifier,
    });
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) addImport(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
      addImport(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined
    )
      addImport(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const expression = node.expression;
      if (
        expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expression) && expression.text === 'require')
      )
        addImport(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  const seen = new Set();
  return imports
    .filter((entry) => {
      const key = `${entry.line}:${entry.specifier}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.line - right.line || left.specifier.localeCompare(right.specifier));
}

async function filesUnder(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(path)));
      continue;
    }
    if (RUNTIME_FILE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) files.push(path);
  }
  return files.sort();
}

function dependencyNames(manifest) {
  const names = new Set();
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (Array.isArray(value)) {
      for (const name of value) names.add(name);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      for (const name of Object.keys(value)) names.add(name);
    }
  }
  return names;
}

async function workspacePackages(packagesRoot) {
  const packages = [];
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = resolve(packagesRoot, entry.name);
    const manifestPath = resolve(directory, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (manifest.private === true || typeof manifest.name !== 'string') continue;
    if (!manifest.name.startsWith('@forgeax/engine')) continue;
    packages.push({ directory, manifest, manifestPath });
  }
  return packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export async function checkPackageRuntimeDependencies({ packagesRoot, requireDist = true }) {
  const packages = await workspacePackages(resolve(packagesRoot));
  const violations = [];
  const missingDist = [];
  const scanned = [];

  for (const entry of packages) {
    const dist = resolve(entry.directory, 'dist');
    let files;
    try {
      files = await filesUnder(dist);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        missingDist.push(entry.manifest.name);
        continue;
      }
      throw error;
    }
    scanned.push(entry.manifest.name);
    const declared = dependencyNames(entry.manifest);
    const devDependencies = new Set(Object.keys(entry.manifest.devDependencies ?? {}));
    const findings = new Map();
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const imported of extractRuntimeEngineImports(source)) {
        if (imported.dependency === entry.manifest.name || declared.has(imported.dependency))
          continue;
        const relativeFile = relative(entry.directory, file).split('\\').join('/');
        const key = `${relativeFile}:${imported.dependency}`;
        const finding = findings.get(key) ?? {
          dependency: imported.dependency,
          devOnly: devDependencies.has(imported.dependency),
          file: relativeFile,
          lines: [],
          packageName: entry.manifest.name,
          specifiers: [],
        };
        finding.lines.push(imported.line);
        if (!finding.specifiers.includes(imported.specifier))
          finding.specifiers.push(imported.specifier);
        findings.set(key, finding);
      }
    }
    violations.push(...findings.values());
  }

  return {
    missingDist: requireDist ? missingDist : [],
    packages: packages.map((entry) => entry.manifest.name),
    scanned,
    violations,
  };
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

export async function main({ root = process.cwd(), packagesDirectory = 'packages' } = {}) {
  const result = await checkPackageRuntimeDependencies({
    packagesRoot: resolve(root, packagesDirectory),
  });
  if (result.missingDist.length > 0) {
    throw new Error(
      `package-runtime-dependency-dist-missing: ${result.missingDist.join(', ')}; build packages before running this check`,
    );
  }
  if (result.violations.length > 0) {
    const details = result.violations
      .map((violation) => {
        const declaration = violation.devOnly
          ? 'move it from devDependencies to dependencies, optionalDependencies, or peerDependencies'
          : 'declare it in dependencies, optionalDependencies, or peerDependencies';
        return `  - ${violation.packageName} ${violation.file}:${violation.lines.join(',')}: ${violation.specifiers.join(', ')}; ${declaration}`;
      })
      .join('\n');
    throw new Error(
      `package-runtime-dependency-closure: ${result.violations.length} violation(s)\n${details}`,
    );
  }
  console.log(
    `package runtime dependency closure: ${result.scanned.length} package(s), all built runtime imports declared`,
  );
  return result;
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  const root = option('--root', process.cwd());
  const packagesDirectory = option('--packages-dir', 'packages');
  await main({ root, packagesDirectory });
}
