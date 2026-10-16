#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('../check-image-pipeline-isolation.mjs', import.meta.url))],
  { cwd: repoRoot, encoding: 'utf8' },
);

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
