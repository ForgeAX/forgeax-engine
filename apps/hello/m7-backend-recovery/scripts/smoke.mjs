#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const root = new URL('../../../..', import.meta.url).pathname;
const env = { ...process.env, INIT_CWD: root, FORGEAX_DAWN_COMPACT: '1' };

function run(label, args, extraEnv = {}) {
  const result = spawnSync('pnpm', args, {
    cwd: root,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status ?? 'unknown'}`);
  console.log(`[m7-backend] ${label}: PASS`);
  return result.stdout ?? '';
}

try {
  run('null/runtime lifecycle + injected renderer recovery', [
    '--filter',
    '@forgeax/engine-runtime',
    'exec',
    'vitest',
    'run',
    'src/__tests__/rhi-null-renderer-lifecycle.unit.test.ts',
    'src/__tests__/rhi-null-command-flow.unit.test.ts',
    'src/__tests__/rhi-null-noop-behavior.unit.test.ts',
    'src/__tests__/renderer-health.unit.test.ts',
    'src/__tests__/renderer-recover.unit.test.ts',
  ]);

  run('wgpu structured contracts', [
    '--filter',
    '@forgeax/engine-rhi-wgpu',
    'exec',
    'vitest',
    'run',
    'src/__tests__/rhi-wgpu.unit.test.ts',
  ]);

  run('browser submit recovery', [
    'exec',
    'node',
    'scripts/ci/run-split-vitest-browser.mjs',
    '--file',
    'packages/rhi-wgpu/src/__tests__/submit-error-fanout.browser.test.ts',
  ]);

  run('browser/driver device-loss recovery', [
    '--filter',
    '@forgeax/hello-m7-backend-recovery',
    'smoke:browser-device-loss',
  ]);

  run('Dawn unsupported fallback rejection', [
    'exec',
    'vitest',
    'run',
    '--project',
    'dawn',
    'packages/runtime/src/__tests__/video-extract-bindgroup.dawn.test.ts',
  ]);

  run('Dawn resize/resource churn', ['--filter', '@forgeax/hello-bloom', 'smoke']);
  const browserCapture = run('browser WebGPU capture', ['--filter', '@forgeax/hello-cube', 'smoke:browser']);
  // The shared capture verifier publishes one self-describing rhi-tape
  // artifact (`captureFrame result`) and performs strict replay/inspection in
  // the same process. The old reportPath output belonged to the retired
  // inspect-core smoke and is intentionally no longer part of the contract.
  const captureLine = browserCapture
    .split('\n')
    .find((line) => line.startsWith('[hello-cube] captureFrame result: '));
  if (captureLine === undefined) {
    throw new Error('browser capture did not publish a captureFrame artifact');
  }
  const captureJson = captureLine.slice('[hello-cube] captureFrame result: '.length);
  const capture = JSON.parse(captureJson);
  if (typeof capture.path !== 'string' || capture.path.length === 0) {
    throw new Error('browser capture artifact did not include a tape path');
  }
  run('same-scene cross-backend replay', [
    'exec',
    'node',
    'apps/hello/m7-backend-recovery/scripts/cross-backend-replay.mjs',
    capture.path,
  ]);
  // The dev capture does not produce a production bundle. This consumer owns
  // the cold tree-shake input, just like the isolated coverage consumer.
  run('cold production cube for tree-shake', ['--filter', '@forgeax/hello-cube', 'build'], {
    FORGEAX_ENGINE_RHI_DEBUG: '0',
  });
  run('debug-only tree-shake', [
    '--filter',
    '@forgeax/engine-rhi-debug',
    'exec',
    'vitest',
    'run',
    'src/__tests__/tree-shake.unit.test.ts',
  ]);

  console.log('[m7-backend] PASS - M7 backend/recovery evidence GREEN');
  console.log(
    '[m7-backend] deferred: physical hardware TDR beyond the Chrome GPU-process crash control is not claimed.',
  );
} catch (error) {
  console.error(`[m7-backend] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
