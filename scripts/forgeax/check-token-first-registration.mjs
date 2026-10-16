#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Project, SyntaxKind } from 'ts-morph';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const APIS = new Set(['addSystem', 'addSystems', 'configureSets', 'removeSystem', 'replaceSystem']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const RAW_BACKSTOP = process.argv.includes('--raw-backstop');
const EXCLUDED_PREFIXES = [
  'dist/',
  'node_modules/',
  '.forgeax-harness/',
  '.worktrees/',
  '.claude/worktrees/',
];

function trackedFiles() {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)
    .filter((path) => EXTENSIONS.has(path.slice(path.lastIndexOf('.'))))
    .filter((path) => !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

function isRawBackstopProduction(path) {
  return !path.startsWith('scripts/forgeax/');
}

function isEcsProduction(path) {
  return (
    path.startsWith('packages/ecs/src/') &&
    !path.includes('/__tests__/') &&
    !path.endsWith('.test-d.ts')
  );
}

function report(path, line, api, actualFirstArgument) {
  return { path, line, api, actualFirstArgument };
}

function astHits(files) {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const hits = [];
  for (const path of files) {
    if (isEcsProduction(path)) continue;
    const sourceFile = project.addSourceFileAtPath(resolve(REPO_ROOT, path));
    sourceFile.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.CallExpression) return;
      const expression = node.getExpression();
      if (expression.getKind() !== SyntaxKind.PropertyAccessExpression) return;
      const api = expression.getName();
      if (!APIS.has(api)) return;
      const args = node.getArguments();
      if (
        (path === 'packages/ecs/src/__tests__/schedule-scope-error.unit.test.ts' &&
          node.getStartLineNumber() === 78) ||
        (path === 'packages/ecs/src/__tests__/schedule-token.unit.test.ts' &&
          node.getStartLineNumber() === 19)
      ) {
        return;
      }
      const first = args[0];
      const text = first?.getText() ?? '<missing>';
      if (text === 'Update' || text === 'FixedUpdate') return;
      hits.push(report(path, node.getStartLineNumber(), api, text));
    });
  }
  return hits;
}

function rawHits(files) {
  const hits = [];
  const pattern =
    /\.(addSystem|addSystems|configureSets|removeSystem|replaceSystem)\(\s*(?!Update\s*,|FixedUpdate\s*,)/g;
  for (const path of files) {
    if (!isRawBackstopProduction(path) || isEcsProduction(path)) continue;
    const lines = readFileSync(resolve(REPO_ROOT, path), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (
        (path === 'packages/ecs/src/__tests__/schedule-scope-error.unit.test.ts' && index === 77) ||
        (path === 'packages/ecs/src/__tests__/schedule-token.unit.test.ts' && index === 18)
      )
        return;
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (!match) return;
      hits.push(report(path, index + 1, match[1], line.slice(match.index).trim()));
    });
  }
  return hits;
}

const files = trackedFiles();
const hits = RAW_BACKSTOP ? rawHits(files) : astHits(files);
if (hits.length > 0) {
  const label = RAW_BACKSTOP ? 'raw code backstop' : 'AST token-first registration';
  process.stderr.write(`${label} gate failed:\n`);
  for (const hit of hits) {
    process.stderr.write(
      `  ${hit.path}:${hit.line} ${hit.api} first argument=${hit.actualFirstArgument}\n`,
    );
  }
  process.stderr.write(
    '\n[hint] Every executable World registration call must pass literal Update or FixedUpdate as its first argument. Docs are intentionally out of scope.\n',
  );
  process.exit(1);
}
process.stdout.write(
  `${RAW_BACKSTOP ? 'raw code backstop' : 'AST token-first registration'} gate passed\n`,
);
