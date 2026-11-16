import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Retain captured output and exit identity while streaming a cold source command before cancellation. */
export async function runViewSourceCommand(file, args, options) {
  const startedAt = performance.now();
  const stage = [file, ...args].join(' ');
  const emit = (phase, result) =>
    process.stderr.write(
      `${JSON.stringify({
        kind: 'view-source-command',
        phase,
        stage,
        cwd: options.cwd,
        elapsedMs: Math.round(performance.now() - startedAt),
        pid: result?.pid,
        status: result?.status,
        signal: result?.signal,
      })}\n`,
    );
  const pending = execute(file, args, options);
  emit('start', { pid: pending.child.pid });
  pending.child.stdout.on('data', (chunk) => process.stderr.write(chunk));
  pending.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  let result;
  try {
    const output = await pending;
    result = { ...output, status: 0, signal: null, pid: pending.child.pid };
  } catch (error) {
    result = {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      status: typeof error.code === 'number' ? error.code : null,
      signal: error.signal ?? null,
      pid: pending.child.pid,
    };
  }
  emit('end', result);
  return result;
}
