#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const result = spawnSync('pnpm', ['--filter', '@forgeax/preview', 'smoke:templates'], {
  cwd: root,
  env: { ...process.env, FORGEAX_TEMPLATE_SMOKE_SLUGS: 'brotato-3d' },
  stdio: 'inherit',
});
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
