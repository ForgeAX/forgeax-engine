#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project=dawn'], {
  cwd: root,
  env: { ...process.env, FORGEAX_TEMPLATE_SMOKE_SLUGS: 'game-capability-lab' },
  stdio: 'inherit',
});
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
