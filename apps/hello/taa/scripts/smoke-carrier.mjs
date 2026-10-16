import { execFile, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { clearTimeout, setTimeout as setTimer } from 'node:timers';
import { promisify } from 'node:util';

const scriptsDir = import.meta.dirname;
export const carrierRepoRoot = resolve(scriptsDir, '..', '..', '..', '..');
const maxDiagnosticCharacters = 4096;
const execFileAsync = promisify(execFile);

const bounded = (value) => {
  const text = typeof value === 'string' ? value : '';
  return text.length <= maxDiagnosticCharacters
    ? text
    : `${text.slice(0, maxDiagnosticCharacters)}...<truncated>`;
};

/**
 * Bound one asynchronous action without leaving a losing timeout in the event
 * loop after the action settles.
 */
export const withTimeout = async (label, action, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimer(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const runCarrier = (script, extraEnv = {}) => {
  const result = spawnSync(process.execPath, [resolve(scriptsDir, script)], {
    cwd: carrierRepoRoot,
    env: { ...process.env, SMOKE_MIN_FRAMES: '60', ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw new Error(`${script} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const caseLabel = extraEnv.SMOKE_CASE ?? 'unspecified';
    const status = result.status === null ? 'null' : String(result.status);
    const signal = result.signal ?? 'none';
    throw new Error(
      `${script} failed case=${caseLabel} status=${status} signal=${signal} ` +
        `stdout=${JSON.stringify(bounded(result.stdout))} stderr=${JSON.stringify(bounded(result.stderr))}`,
    );
  }
  return result.stdout;
};

/**
 * Run one carrier without blocking the parent process.
 *
 * The falsifier owns several independent browser processes. Keeping the
 * synchronous helper above preserves the Dawn/performance callers, while this
 * bounded async seam lets the browser cases overlap without sharing a Vite,
 * page, or GPU device between cases.
 */
export const runCarrierAsync = async (script, extraEnv = {}) => {
  try {
    const pending = execFileAsync(process.execPath, [resolve(scriptsDir, script)], {
      cwd: carrierRepoRoot,
      env: { ...process.env, SMOKE_MIN_FRAMES: '60', ...extraEnv },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    // Keep live diagnostics visible while retaining stdout for receipt parsing.
    pending.child.stdout.pipe(process.stderr, { end: false });
    pending.child.stderr.pipe(process.stderr, { end: false });
    const result = await pending;
    return result.stdout;
  } catch (error) {
    const caseLabel = extraEnv.SMOKE_CASE ?? 'unspecified';
    const status = error?.status === undefined ? 'null' : String(error.status);
    const signal = error?.signal ?? 'none';
    const stdout = bounded(error?.stdout);
    const stderr = bounded(error?.stderr);
    throw new Error(
      `${script} failed case=${caseLabel} status=${status} signal=${signal} ` +
        `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
      { cause: error },
    );
  }
};
