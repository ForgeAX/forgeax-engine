#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(here, '..', '..', '..', '..');
const childEnv = { ...process.env, INIT_CWD: root };

function run(label, args) {
  try {
    execFileSync('pnpm', args, { cwd: root, env: childEnv, stdio: 'inherit' });
    console.log(`[m5-interactive] ${label}: PASS`);
  } catch (error) {
    throw new Error(`${label} failed with status ${error?.status ?? 'unknown'}`);
  }
}

function runExpectedFailure(label, args, expectedToken) {
  const result = spawnSync('pnpm', args, {
    cwd: root,
    env: { ...childEnv, FALSIFY: 'skip-shapes' },
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) throw new Error(`${label} unexpectedly passed`);
  if (!combined.includes(expectedToken)) {
    throw new Error(`${label} failed without structured token ${expectedToken}`);
  }
  console.log(`[m5-interactive] ${label}: PASS (expected non-zero falsifier)`);
}

try {
  run('picking front door', ['--filter', '@forgeax/hello-picking', 'smoke']);
  run('picking browser front door', ['--filter', '@forgeax/hello-picking', 'smoke:browser']);
  run('debug-draw front door', ['--filter', '@forgeax/hello-debug-draw', 'smoke']);
  run('runtime debug-draw browser front door', [
    '--filter',
    '@forgeax/hello-debug-draw',
    'smoke:browser',
  ]);
  runExpectedFailure(
    'debug-draw falsifier',
    ['--filter', '@forgeax/hello-debug-draw', 'smoke'],
    'zero foreground pixels',
  );
  run('picking contracts', ['--filter', '@forgeax/engine-picking', 'test']);
  run('debug-draw contracts', ['--filter', '@forgeax/engine-debug-draw', 'test']);
  run('text Dawn front door', ['--filter', '@forgeax/hello-text', 'smoke']);
  run('tilemap Dawn front door', ['--filter', '@forgeax/hello-tilemap', 'smoke']);
  run('video texture browser front door', ['--filter', '@forgeax/video-texture', 'smoke:browser']);
  run('video cutscene browser front door', ['--filter', '@forgeax/hello-video-cutscene', 'smoke:browser']);
  console.log('[m5-interactive] PASS - M5 interaction/media gates GREEN');
  console.log('[m5-interactive] deferred: none.');
} catch (error) {
  console.error(`[m5-interactive] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
