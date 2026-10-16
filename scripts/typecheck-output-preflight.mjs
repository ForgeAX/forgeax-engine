#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(process.env.FORGEAX_REPO_ROOT ?? '.');

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '__tests__' ||
      entry.name === 'test' ||
      entry.name === 'tests'
    )
      continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(path));
    else if (
      entry.isFile() &&
      /\.(?:ts|tsx|mts|cts)$/.test(entry.name) &&
      !/\.d\.(?:ts|mts|cts)$/.test(entry.name) &&
      !/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(entry.name)
    )
      result.push(path);
  }
  return result;
}

function projects() {
  const packagesRoot = resolve(root, 'packages');
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(packagesRoot, entry.name))
    .filter((directory) => existsSync(resolve(directory, 'tsconfig.json')))
    .map((directory) => ({
      directory,
      tsconfig: resolve(directory, 'tsconfig.json'),
      config: JSON.parse(readFileSync(resolve(directory, 'tsconfig.json'), 'utf8')),
    }))
    .filter(
      ({ config }) =>
        config.compilerOptions?.declaration === true && config.compilerOptions?.noEmit !== true,
    );
}

function missingDeclarations() {
  const missing = [];
  for (const project of projects()) {
    const options = project.config.compilerOptions ?? {};
    const sourceRoot = resolve(project.directory, options.rootDir ?? 'src');
    const outputRoot = resolve(
      project.directory,
      options.declarationDir ?? options.outDir ?? 'dist',
    );
    for (const source of sourceFiles(sourceRoot)) {
      const output = resolve(
        outputRoot,
        relative(sourceRoot, source).replace(/\.(?:tsx|mts|cts|ts)$/, '.d.ts'),
      );
      if (!existsSync(output)) {
        missing.push({ project: project.tsconfig, output });
        break;
      }
    }
  }
  return missing;
}

const missing = missingDeclarations();

if (missing.length === 0) {
  console.error('[types-preflight] declaration inventory complete');
  process.exit(0);
}

console.error(
  `[types-preflight] ${missing.length} project(s) have missing declarations; forcing project rebuild`,
);
for (const item of missing)
  console.error(`[types-preflight] missing ${relative(root, item.output)}`);

const args =
  missing.length > 3
    ? ['-b', '--force']
    : ['-b', ...missing.map((item) => relative(root, item.project)), '--force'];
function buildDeclarations(buildArgs) {
  return spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/typescript/bin/tsc'), ...buildArgs],
    {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      env: process.env,
    },
  );
}

// A cold solution build can cache a missing declaration through a workspace
// symlink before its producer emits the real path. Populate declarations first;
// the separate forced checked build must still reject every semantic error.
const emit = buildDeclarations([...args, '--noCheck']);
if (emit.status !== 0) process.exit(emit.status ?? 1);
const checked = buildDeclarations(args);
process.exit(checked.status ?? 1);
