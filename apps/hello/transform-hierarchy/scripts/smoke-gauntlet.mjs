#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReceipt } from './dataflow-receipt.mjs';

if (process.argv.includes('--receipt')) {
  console.log(JSON.stringify(createReceipt({
    workloadId: 'structural-churn',
    backend: 'unavailable',
    reasonCode: 'gauntlet-not-run',
    detail: 'Receipt-only mode does not start the Dawn and Browser legs.',
    retryHint: 'Run this script without --receipt on a dual-backend runner.',
  }), null, 2));
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const root = resolve(appRoot, '..', '..', '..', '..');
const env = { ...process.env };

for (const [label, script] of [
  ['Dawn', 'smoke-dawn.mjs'],
  ['Browser', 'smoke-browser.mjs'],
]) {
  const result = spawnSync(process.execPath, [resolve(here, script)], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`[m23] ${label} leg failed with status ${result.status ?? 'signal'}`);
    process.exit(result.status ?? 1);
  }
}

console.log('[m23] gauntlet: Dawn + Browser structured hierarchy recovery: PASS');
