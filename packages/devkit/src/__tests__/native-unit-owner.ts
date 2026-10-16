import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import type { TestContext } from 'vitest';

const workspace = fileURLToPath(new URL('../../../../', import.meta.url));
const runner = new URL('../../../../scripts/ci/run-browser-gate-with-retry.mjs', import.meta.url);

// A separate owner process lets the existing Vitest case signal cancel the
// maintained lease wait without signalling the other cases in this worker.
// The maintained runner retains the lease until native descendants are gone.
const owner = `
import { runBrowserCommand } from ${JSON.stringify(runner.href)};
const lostParent = () => process.kill(process.pid, 'SIGTERM');
process.on('disconnect', lostParent);
process.once('message', async ({ command, timeoutMs, cwd }) => {
  try {
    const result = await runBrowserCommand(command, { cwd, timeoutMs, gpuLease: true });
    process.exitCode = result.status;
  } catch (error) {
    console.error(error);
    process.exitCode ||= 1;
  } finally {
    process.off('disconnect', lostParent);
    if (process.connected) process.disconnect();
  }
});
if (process.connected) process.send('ready');
`;

export async function runPreparedNativeUnit(
  context: Pick<TestContext, 'signal' | 'onTestFinished'>,
  command: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  context.signal.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Native unit owner exhausted its original case budget before admission');
  const started = performance.now();
  const child = spawn(process.execPath, ['--input-type=module', '-e', owner], {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const closed = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  const cancel = () => {
    child.kill('SIGTERM');
  };
  context.signal.addEventListener('abort', cancel, { once: true });
  context.onTestFinished(async () => {
    cancel();
    await closed;
  });
  assert(child.stdout && child.stderr, 'Native owner must capture both stdout and stderr');
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
    process.stderr.write(chunk);
  });
  child.once('message', () => {
    const remaining = timeoutMs - (performance.now() - started);
    if (context.signal.aborted || remaining <= 0) cancel();
    else child.send({ command, timeoutMs: remaining, cwd: workspace });
  });
  try {
    const code = await closed;
    context.signal.throwIfAborted();
    if (code !== 0) throw new Error(`Prepared native unit owner exited ${code}\n${output}`);
  } finally {
    context.signal.removeEventListener('abort', cancel);
  }
}

export function nativeUnitCommand(file: string, name: string): string[] {
  return [
    process.execPath,
    resolve(workspace, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'packages/devkit/vitest.config.ts',
    file,
    '--testNamePattern',
    `^${name}$`,
    '--maxWorkers=1',
    '--fileParallelism=false',
    '--retry=0',
  ];
}

export async function softwareGraphicsGuard(): Promise<string> {
  // Use the maintained Host guard in both Window and Worker realms.
  return (await readFile(resolve(workspace, 'config/browser-host-guard.mjs'), 'utf8')).replace(
    '[HTMLCanvasElement.prototype, OffscreenCanvas.prototype]',
    '[globalThis.HTMLCanvasElement?.prototype, globalThis.OffscreenCanvas?.prototype].filter(Boolean)',
  );
}

export async function assertSoftwareGraphicsGuard(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const gpu = Object.getOwnPropertyDescriptor(navigator, 'gpu')?.value;
    // A missing guard fails before any physical acquisition falsifier runs.
    if (!gpu || !Object.isFrozen(gpu)) return { installed: false, rejected: [] };
    const rejected: string[] = [];
    for (const acquire of [
      () => gpu.requestAdapter(),
      () => document.createElement('canvas').getContext('webgl2'),
      () => new OffscreenCanvas(1, 1).getContext('webgpu'),
    ]) {
      try {
        acquire();
        rejected.push('not rejected');
      } catch (error) {
        rejected.push(String(error));
      }
    }
    return { installed: true, rejected };
  });
  assert.equal(
    result.installed,
    true,
    'Software unit page must install the maintained graphics guard',
  );
  for (const error of result.rejected)
    assert.match(error, /Browser host contract requested graphics; use the native GPU test config/);
}
