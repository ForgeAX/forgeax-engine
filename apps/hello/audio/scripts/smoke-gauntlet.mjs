#!/usr/bin/env node
// Formal M20 gauntlet: retain the existing Dawn front door, then run the real
// Chrome stale-decode/replacement journey with the browser decoder gate.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function run(label, command, args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: resolve(HERE, '..'),
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(new Error(`${label} exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
  });
}

try {
  await run('Dawn audio smoke', process.execPath, ['scripts/smoke.mjs']);
  console.log('[m20] Dawn normal audio front door: PASS');
  await run('Browser stale-decode smoke', process.execPath, ['scripts/smoke-browser.mjs'], {
    FORGEAX_AUDIO_M20: '1',
  });
  console.log('[m20] gauntlet: Dawn + Browser stale-decode epoch recovery: PASS');
} catch (error) {
  console.error(`[m20] gauntlet: FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
