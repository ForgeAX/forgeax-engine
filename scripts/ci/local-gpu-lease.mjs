import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const holderPath = fileURLToPath(
  new URL(windows ? './local-gpu-lease.ps1' : './local-gpu-lease.py', import.meta.url),
);
const defaultLockPath = windows
  ? `${process.env.SystemDrive ?? 'C:'}/tmp/forgeax-physical-gpu.lock`
  : '/tmp/forgeax-physical-gpu.lock';

// Lease only one complete native owner. Preparation and the gate's remaining
// owners stay outside this callback; existing Python flock users interoperate.
export async function withLocalGpuLease(
  run,
  { lockPath = defaultLockPath, label = 'native group' } = {},
) {
  const queuedAt = performance.now();
  const holder = spawn(
    windows
      ? join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        )
      : 'python3',
    windows
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          holderPath,
          resolve(lockPath),
        ]
      : [holderPath, lockPath],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  let holderFailure;
  const closed = new Promise((resolve) => {
    holder.once('error', (error) => {
      holderFailure = error;
    });
    holder.once('close', (code) => resolve(code));
  });
  let acquiredAt;
  let cancellation;
  let onSigint;
  let onSigterm;
  const heartbeat = setInterval(() => {
    process.stderr.write(
      `[local-gpu] waiting label=${label} queueMs=${Math.round(performance.now() - queuedAt)} at=${new Date().toISOString()}\n`,
    );
  }, 30_000);
  const ready = new Promise((resolve, reject) => {
    let output = '';
    let errorOutput = '';
    holder.stderr.on('data', (chunk) => {
      errorOutput = (errorOutput + chunk).slice(-4096);
    });
    holder.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) {
        try {
          if (JSON.parse(output.trim()).acquired !== true) throw new Error('missing acquisition');
          acquiredAt = performance.now();
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    });
    holder.once('error', reject);
    holder.once('close', (code) => {
      if (acquiredAt === undefined)
        reject(
          new Error(
            `GPU lease was not acquired: ${holderFailure?.message ?? (errorOutput.trim() || `holder exit ${code}`)}`,
          ),
        );
    });
    const cancel = (signal) => {
      cancellation = signal;
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
      reject(new Error(`GPU lease wait cancelled by ${signal}`));
    };
    onSigint = () => cancel('SIGINT');
    onSigterm = () => cancel('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  });
  const stopWaiting = () => {
    clearInterval(heartbeat);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
  // A missing Python executable can close the pipe before finalization.
  holder.stdin.on('error', () => {});
  process.stderr.write(
    `[local-gpu] queued label=${label} lock=${lockPath} at=${new Date().toISOString()}\n`,
  );
  let nativeResult;
  let holderCode;
  try {
    await ready;
    stopWaiting();
    const gpuQueueMs = Math.round(acquiredAt - queuedAt);
    process.stderr.write(
      `[local-gpu] acquired label=${label} queueMs=${gpuQueueMs} at=${new Date().toISOString()}\n`,
    );
    const result = await run();
    const gpuExecutionMs = Math.round(performance.now() - acquiredAt);
    nativeResult =
      result && typeof result === 'object' ? { ...result, gpuQueueMs, gpuExecutionMs } : result;
  } finally {
    stopWaiting();
    // runBrowserCommand returns only after its owned descendants are gone.
    // Closing this pipe now releases the lease, never on native leader exit.
    holder.stdin.end();
    holderCode = await closed;
    process.stderr.write(
      `[local-gpu] released label=${label} queueMs=${Math.round((acquiredAt ?? performance.now()) - queuedAt)} executionMs=${acquiredAt === undefined ? 0 : Math.round(performance.now() - acquiredAt)} at=${new Date().toISOString()}\n`,
    );
  }
  if (!cancellation && holderCode !== 0)
    throw new Error(`GPU lease holder failed (${holderCode}); native result is invalid`);
  return nativeResult;
}

// Prepared standalone probes and the Browser suite's three independent owners
// use this same boundary. The environment switch leaves hosted CI unchanged.
async function main() {
  try {
    const processOnly = process.argv[2] === '--process-only';
    const timeoutIndex = processOnly ? 3 : 2;
    const separatorIndex = timeoutIndex + 2;
    const timeoutMs = Number(process.argv[timeoutIndex + 1]);
    if (
      process.argv[timeoutIndex] !== '--timeout-ms' ||
      process.argv[separatorIndex] !== '--' ||
      process.argv.length < separatorIndex + 2
    )
      throw new Error(
        'usage: local-gpu-lease.mjs [--process-only] --timeout-ms MILLISECONDS -- COMMAND [ARGS...]',
      );
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
      throw new Error('timeout-ms must be a positive integer within the Node timer range');
    const { runBrowserCommand } = await import('./run-browser-gate-with-retry.mjs');
    const commandEnv = { ...process.env, FORGEAX_LOCAL_PROCESS_BUDGET_HELD: '1' };
    if (processOnly) delete commandEnv.FORGEAX_LOCAL_GPU_LEASE_HELD;
    const result = await runBrowserCommand(process.argv.slice(separatorIndex + 1), {
      gpuLease: !processOnly,
      excludeGpuLeaseQueue: processOnly,
      timeoutMs,
      env: commandEnv,
    });
    process.exitCode = result.status;
  } catch (error) {
    process.stderr.write(`[local-gpu] ${error.message}\n`);
    process.exitCode ||= 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
