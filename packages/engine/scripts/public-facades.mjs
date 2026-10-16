import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

export async function publicEngineMembers(repositoryRoot, directories) {
  const selectedDirectories = directories === undefined ? undefined : new Set(directories);
  const members = [];
  for (const entry of await readdir(resolve(repositoryRoot, 'packages'), { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name === 'engine' ||
      (selectedDirectories !== undefined && !selectedDirectories.has(entry.name))
    ) {
      continue;
    }
    try {
      const manifest = JSON.parse(
        await readFile(resolve(repositoryRoot, 'packages', entry.name, 'package.json'), 'utf8'),
      );
      if (
        manifest.private !== true &&
        typeof manifest.name === 'string' &&
        manifest.name.startsWith('@forgeax/engine-')
      ) {
        members.push({
          directory: entry.name,
          exports: manifest.exports,
          name: manifest.name,
          packageRoot: resolve(repositoryRoot, 'packages', entry.name),
        });
      }
    } catch {
      // A non-package directory is outside the generated public facade set.
    }
  }
  return members.sort((left, right) => left.directory.localeCompare(right.directory));
}

function exportTargets(member, subpath) {
  const exportValue = member.exports?.[subpath];
  const targets = [];
  const visit = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) targets.push(resolve(member.packageRoot, value));
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const condition of ['import', 'node', 'browser', 'default']) {
      if (Object.hasOwn(value, condition)) visit(value[condition]);
    }
  };
  visit(exportValue);
  return [...new Set(targets)];
}

function hasDefaultExport(filePaths) {
  if (filePaths.length === 0) return false;
  return filePaths.every((filePath) => {
    let source;
    try {
      source = readFileSync(filePath, 'utf8');
    } catch {
      return false;
    }
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    return sourceFile.statements.some((statement) => {
      if (ts.isExportAssignment(statement)) return !statement.isExportEquals;
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        return statement.exportClause.elements.some((element) => element.name.text === 'default');
      }
      return statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword) ?? false;
    });
  });
}

function facadeFor(member, exportSubpath, facadeSubpath, source) {
  return {
    subpath: facadeSubpath,
    source,
    hasDefault: hasDefaultExport(exportTargets(member, exportSubpath)),
  };
}

export function publicEngineFacades(members) {
  const facades = [];
  for (const member of members) {
    const packageExports = member.exports;
    const hasRootExport =
      packageExports === undefined ||
      packageExports === null ||
      typeof packageExports !== 'object' ||
      Array.isArray(packageExports) ||
      Object.hasOwn(packageExports, '.');
    if (hasRootExport) facades.push(facadeFor(member, '.', member.directory, member.name));
    if (
      packageExports === null ||
      typeof packageExports !== 'object' ||
      Array.isArray(packageExports)
    ) {
      continue;
    }
    for (const subpath of Object.keys(packageExports)) {
      if (subpath === '.' || subpath === './package.json' || subpath.includes('*')) continue;
      const relativeSubpath = subpath.slice(2);
      facades.push(
        facadeFor(
          member,
          subpath,
          `${member.directory}/${relativeSubpath}`,
          `${member.name}/${relativeSubpath}`,
        ),
      );
    }
  }
  return facades;
}

export function publicEngineFacadeSubpaths(members) {
  return new Set(publicEngineFacades(members).map(({ subpath }) => subpath));
}
