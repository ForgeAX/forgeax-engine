#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const runner = resolve(repoRoot, 'scripts/forgeax/run-format-tier1-final-gates.mjs');
const result = spawnSync(process.execPath, [runner, ...process.argv.slice(2)], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
