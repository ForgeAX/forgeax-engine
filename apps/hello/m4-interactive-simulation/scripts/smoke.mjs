#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(here, '..', '..', '..', '..');
const childEnv = { ...process.env, INIT_CWD: root };
const CHILD_TIMEOUT_MS = 180_000;
// Keep every M4 Vitest child within the CI runner's bounded heap. The browser
// and Dawn jobs already consume concurrent resources on the shared runner.
// A single fork keeps native Rapier/WASM state isolated from the parent while
// the bounded teardown window lets GPU/WASM cleanup finish before the next
// sequential lifecycle child starts.
const BOUNDED_VITEST_ARGS = ['--maxWorkers=1', '--teardownTimeout=5000'];

function run(label, args, env = childEnv) {
  console.log(`[m4-interactive] START - ${label}`);
  try {
    execFileSync('pnpm', args, {
      cwd: root,
      env,
      stdio: 'inherit',
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });
    console.log(`[m4-interactive] ${label}: PASS`);
  } catch (error) {
    const status = error?.timedOut
      ? `timeout after ${CHILD_TIMEOUT_MS}ms`
      : (error?.status ?? error?.signal ?? 'unknown');
    throw new Error(`${label} failed with status ${status}`);
  }
}

try {
  run('physics gravity/readiness', ['--filter', '@forgeax/hello-physics', 'smoke']);
  run('character fixed-step/collision', ['--filter', '@forgeax/hello-character', 'smoke']);
  run('audio app lifecycle', ['--filter', '@forgeax/hello-audio', 'smoke']);
  run('audio browser gesture/spatial pan/collision cleanup', ['--filter', '@forgeax/hello-audio', 'smoke:browser']);
  // Keep each Rapier 2D file in its own Vitest process. Running both files
  // through the root workspace config retains the first WASM lifecycle in
  // the runner and can exhaust the 2 GiB Node heap before the second file.
  const physics2dArgs = [
    'exec',
    'vitest',
    'run',
    '--config',
    'packages/physics-rapier2d/vitest.config.ts',
    '--testNamePattern',
    'AC-12|ECS bridge|despawn|collision|free-fall|kinematic|gravity|error',
    ...BOUNDED_VITEST_ARGS,
  ];
  run('2D physics ECS/KCC move-and-slide lifecycle', [
    ...physics2dArgs,
    'packages/physics-rapier2d/__tests__/moveandslide-2d.test.ts',
  ]);
  run('2D physics ECS/KCC free-fall lifecycle', [
    ...physics2dArgs,
    'packages/physics-rapier2d/__tests__/free-fall-collision.test.ts',
  ]);
  console.log('[m4-interactive] 2D physics ECS/KCC lifecycle: PASS');
  run('physics lifecycle tests', [
    'exec',
    'vitest',
    'run',
    '--config',
    'packages/physics-rapier3d/vitest.config.ts',
    'packages/physics-rapier3d/src/__tests__/physics-rapier3d.unit.test.ts',
    '--testNamePattern',
    'dynamic ball falls|moveAndSlide|CollidingEntities|childof-kinematic|despawn cleanup|hasBody readiness',
    ...BOUNDED_VITEST_ARGS,
  ]);
  run('audio lifecycle tests', [
    'exec',
    'vitest',
    'run',
    '--config',
    'packages/audio-webaudio/vitest.config.ts',
    'packages/audio-webaudio/src/__tests__/audio-webaudio.unit.test.ts',
    '--testNamePattern',
    'bus|routing|declarative playback|Entity despawn cleanup|listener getter|audioListenerSyncSystem|spatialBlend|edge detection|destroy then new backend|concurrent backends|F24',
    ...BOUNDED_VITEST_ARGS,
  ]);
  console.log('[m4-interactive] PASS - M4 interactive simulation gates GREEN');
} catch (error) {
  console.error(`[m4-interactive] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
