#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['scripts/smoke-cube-camera-browser.mjs'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  stdio: 'inherit',
  env: { ...process.env, FORGEAX_BROWSER_HEADLESS: '0', VITE_REFLECTION_PROBE_EVIDENCE: '1' },
});

process.exitCode = result.status ?? 1;
