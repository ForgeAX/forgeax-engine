#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['scripts/smoke-cube-camera-browser.mjs'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  // Keep the producer report available to the outer evidence consumer. Using
  // `inherit` makes `spawnSync` expose no stdout/stderr, so the completed
  // producer run is rendered successfully but `smoke-browser.mjs` cannot
  // parse its `report=` line.
  stdio: ['inherit', 'pipe', 'pipe'],
  env: {
    ...process.env,
    FORGEAX_BROWSER_HEADLESS: process.env.FORGEAX_BROWSER_HEADLESS ?? '0',
    VITE_REFLECTION_PROBE_EVIDENCE: '1',
  },
});

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error !== undefined) throw result.error;
if (result.signal !== null) throw new Error(`Browser evidence subprocess terminated by ${result.signal}`);


process.exitCode = result.status ?? 1;
