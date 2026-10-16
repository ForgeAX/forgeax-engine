#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const packageName = '@forgeax/hello-boss-lightning';
const run = (args, env = {}) =>
  spawnSync('pnpm', ['--filter', packageName, ...args], {
    cwd: resolveRepoRoot(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });

function resolveRepoRoot() {
  return new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
}

const dawn = run(['smoke'], { BOSS_LIGHTNING_M11: '1' });
process.stdout.write(dawn.stdout ?? '');
process.stderr.write(dawn.stderr ?? '');
if (dawn.status !== 0 || !dawn.stdout?.includes('[m11-vfx] Dawn generation fence: PASS')) {
  process.exit(dawn.status ?? 1);
}

const browser = run(['exec', 'node', 'scripts/smoke-m11-browser.mjs']);
process.stdout.write(browser.stdout ?? '');
process.stderr.write(browser.stderr ?? '');
if (browser.status !== 0) process.exit(browser.status ?? 1);

console.log('[m11-vfx] PASS - M11 VFX generation-fenced device-loss gates GREEN');
