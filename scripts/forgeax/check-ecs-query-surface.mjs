#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT), '..', '..');
const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const scanRoot = rootArg >= 0 ? resolve(args[rootArg + 1]) : REPO_ROOT;
const forbidden = [
  'create' + 'QueryState',
  'query' + 'RunContiguous',
  'query' + 'Run',
  'query' + 'Combinations',
  'Query' + 'State',
  'Nested' + 'ColumnBundle',
  'Column' + 'Bundle',
];
const forbiddenPatterns = forbidden.map((symbol) => [symbol, new RegExp(`\\b${symbol}\\b`, 'u')]);
const extensions = new Set(['.cjs', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.tsx']);
const roots = ['packages', 'apps', 'templates', 'skills', 'scripts'];
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const allowlistedHistory = new Set(['packages/ecs/CHANGELOG.md']);
const selfExclusions = new Set([
  'scripts/forgeax/check-ecs-query-surface.mjs',
  'scripts/forgeax/__tests__/check-ecs-query-surface.test.mjs',
]);

function filesUnder(path) {
  if (!statSync(path).isDirectory()) return [path];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    if (entry.isDirectory() && entry.name === '__fixtures__' && scanRoot === REPO_ROOT) continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

const candidates =
  scanRoot === REPO_ROOT
    ? roots.flatMap((root) => {
        const path = resolve(scanRoot, root);
        try {
          return filesUnder(path);
        } catch {
          return [];
        }
      })
    : filesUnder(scanRoot);
const hits = [];
const audited = { source: 0, script: 0, data: 0, docs: 0 };

for (const file of candidates) {
  if (!extensions.has(extname(file))) continue;
  const path = relative(scanRoot, file).replaceAll('\\', '/');
  const repoPath = relative(REPO_ROOT, file).replaceAll('\\', '/');
  if (
    scanRoot === REPO_ROOT &&
    (allowlistedHistory.has(repoPath) || selfExclusions.has(repoPath))
  ) {
    continue;
  }
  const channel = ['.md', '.html'].includes(extname(file))
    ? 'docs'
    : extname(file) === '.json'
      ? 'data'
      : repoPath.startsWith('scripts/')
        ? 'script'
        : 'source';
  audited[channel]++;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    for (const [symbol, pattern] of forbiddenPatterns) {
      if (pattern.test(lines[index] ?? '')) hits.push(`${path}:${index + 1}:${symbol}`);
    }
  }
}

process.stdout.write(
  `ecs query surface audit: source=${audited.source} script=${audited.script} data=${audited.data} docs=${audited.docs}\n`,
);
if (hits.length > 0) {
  process.stderr.write(`ECS_QUERY_SURFACE_STALE\n${hits.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('ecs query surface audit PASS\n');
