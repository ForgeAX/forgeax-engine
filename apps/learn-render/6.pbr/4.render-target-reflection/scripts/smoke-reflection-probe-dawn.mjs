#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['scripts/smoke-dawn.mjs'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  stdio: 'inherit',
  env: { ...process.env, VITE_REFLECTION_PROBE_EVIDENCE: '1' },
});

if (result.status !== 0) process.exitCode = result.status ?? 1;
process.exitCode = result.status ?? 1;
