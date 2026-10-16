#!/usr/bin/env node
// M3 grep-zero verification: assert the retired console package names are
// absent from source + package.json + gate
// + CI layer. Allowlisted paths:
//   (a) apps/** (M5 migrates these)
//   (b) *.md + README.md (M6 rewrites docs)
//   (c) Packaging schemas (pack/*/schema/*.json) — historical examples
//   (d) Test snapshots that cite old paths as historical context
//
// plan-strategy §7 M3 boundary check: grep both patterns zero (ex allowlisted)

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const PATTERNS = [
  /@forgeax\/engine-console/g,
  /forgeax-engine-console-/g,
];

const ALLOWLISTED_DIRS = [
  'apps/',
];

const ALLOWLISTED_EXTS = new Set(['.md']);

const ALLOWLISTED_FILES = new Set([
  // Test snapshots that cite historical paths as context
  'packages/ecs/__tests__/__fixtures__/inspect-scripts.snapshot.ts',
  'packages/ecs/src/__tests__/__fixtures__/inspect-scripts.snapshot.ts',
  // Historical CI comment about grep-console-errors.mjs
  '.github/workflows/ci.yml',
]);

function isAllowlisted(filePath) {
  for (const dir of ALLOWLISTED_DIRS) {
    if (filePath.startsWith(dir)) return true;
  }
  const dot = filePath.lastIndexOf('.');
  if (dot >= 0) {
    const ext = filePath.slice(dot);
    if (ALLOWLISTED_EXTS.has(ext)) return true;
  }
  if (ALLOWLISTED_FILES.has(filePath)) return true;
  return false;
}

function main() {
  let exitCode = 0;
  const hits = [];

  try {
    const stdout = execFileSync('grep', [
      '-rn',
      '-e', '@forgeax/engine-console',
      '-e', 'forgeax-engine-console-',
      '--include=*.ts',
      '--include=*.mjs',
      '--include=*.json',
      'packages/',
      '.github/',
      'package.json',
      'pnpm-workspace.yaml',
    ], { encoding: 'utf8', cwd: process.cwd() });

    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const colon = line.indexOf(':');
      const file = line.slice(0, colon);

      // Skip node_modules, dist, and packages/remote/scripts (gates self-reference)
      if (file.includes('node_modules') || file.includes('/dist/') ||
          file.startsWith('packages/remote/scripts/')) continue;

      if (isAllowlisted(file)) continue;

      hits.push(line);
    }
  } catch (e) {
    if (e.status !== 1) {
      process.stderr.write(`[fail] grep failed: ${e.message}\n`);
      process.exit(2);
    }
  }

  // Also check package.json files for the retired console prefix
  // (the first grep already covers *.json but double-check with explicit path)
  try {
    const pkgDirs = readdirSync(join(process.cwd(), 'packages'));
    for (const dir of pkgDirs) {
      const pkgPath = join(process.cwd(), 'packages', dir, 'package.json');
      try {
        const text = readFileSync(pkgPath, 'utf8');
        for (const pat of PATTERNS) {
          const regex = new RegExp(pat.source, pat.flags);
          if (regex.test(text)) {
            hits.push(`${pkgPath}: contains ${pat.source}`);
          }
        }
      } catch {
        // package.json may not exist for some dirs
      }
    }
  } catch (e) {
    process.stderr.write(`[fail] pkg.json check failed: ${e.message}\n`);
    process.exit(2);
  }

  if (hits.length > 0) {
    process.stderr.write(`[fail] AC-06 + plan-strategy §7 M3: residual retired console names outside allowlisted paths:\n`);
    for (const h of hits) {
      process.stderr.write(`  ${h}\n`);
    }
    process.stderr.write(`\n  expected: 0 hits (allowlisted: apps/** M5, *.md M6, test snapshots, CI historical comment)\n`);
    process.stderr.write(`  hits: ${hits.length}\n`);
    exitCode = 1;
  } else {
    process.stdout.write(`[ok] AC-06 + plan-strategy §7 M3: zero retired console names outside allowlisted paths (apps M5, *.md M6, test snapshots)\n`);
  }

  process.exit(exitCode);
}

main();
