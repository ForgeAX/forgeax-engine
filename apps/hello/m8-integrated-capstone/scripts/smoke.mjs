#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const env = { ...process.env, INIT_CWD: root };
function run(label, args) {
  const result = spawnSync('pnpm', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status ?? 'unknown'}`);
  return result.stdout ?? '';
}

try {
  const browser = run('browser long-lived journey', ['--filter', '@forgeax/hello-m8-integrated-capstone', 'smoke:browser']);
  if (!browser.includes('[m8-capstone] content reimport/HMR: PASS') || !browser.includes('[m8-capstone] remote-live mutation: PASS') || !browser.includes('[m8-capstone] RHI capture/inspect: PASS') || !browser.includes('[m8-capstone] structured fault/recovery: PASS')) {
    throw new Error('browser journey did not emit all content/live/RHI/fault oracle tokens');
  }
  run('Dawn shared-scene journey', ['--filter', '@forgeax/hello-m8-integrated-capstone', 'smoke:dawn']);
  console.log('[m8-capstone] PASS - M8 integrated capstone gates GREEN');
} catch (error) {
  console.error(`[m8-capstone] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
