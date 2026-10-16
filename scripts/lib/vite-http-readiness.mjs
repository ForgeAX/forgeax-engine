import { setTimeout as sleep } from 'node:timers/promises';

// biome-ignore lint/suspicious/noControlCharactersInRegex: Vite colors its Local origin with ANSI escapes.
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/**
 * Observe one spawned Vite process until its advertised origin serves HTTP.
 * Startup allowance is independent from every page and journey timeout.
 */
export function observeViteHttpReadiness(
  viteProcess,
  {
    timeoutEnvName,
    defaultTimeoutMs = 180_000,
    outputLimit = 4_000,
    pollIntervalMs = 200,
    requestTimeoutMs = 1_000,
  },
) {
  const configuredTimeoutMs = Number(process.env[timeoutEnvName] ?? defaultTimeoutMs);
  const timeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : defaultTimeoutMs;
  let origin;
  let output = '';
  let stdoutPendingLine = '';
  let spawnError;
  let exit;
  const boundedOutputLimit = Math.max(1, outputLimit);
  const stdoutLineLimit = Math.max(2_048, boundedOutputLimit);
  const appendBounded = (current, text, limit) => `${current}${text}`.slice(-limit);
  viteProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output = appendBounded(output, text, boundedOutputLimit);
    process.stdout.write(`[vite] ${text}`);
    const completeLines = `${stdoutPendingLine}${text}`.split('\n');
    stdoutPendingLine = completeLines.pop() ?? '';
    for (const line of completeLines) {
      const plainLine = line.replace(/\r$/, '').replace(ANSI_ESCAPE_PATTERN, '');
      origin ??= plainLine.match(/Local:\s+(https?:\/\/[^\s]+)/)?.[1];
    }
    stdoutPendingLine = stdoutPendingLine.slice(-stdoutLineLimit);
  });
  viteProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    output = appendBounded(output, text, boundedOutputLimit);
    process.stderr.write(`[vite-err] ${text}`);
  });
  viteProcess.once('error', (error) => {
    spawnError = error;
  });
  viteProcess.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  const diagnostics = (startedAt, lastStatus) => ({
    elapsedMs: Date.now() - startedAt,
    timeoutMs,
    pid: viteProcess.pid ?? null,
    origin: origin ?? null,
    lastStatus: lastStatus ?? null,
    spawnError: spawnError === undefined ? null : String(spawnError),
    exit: exit ?? null,
    output: output.trim() || 'none',
  });

  return {
    async wait() {
      const startedAt = Date.now();
      let lastStatus;
      while (Date.now() - startedAt < timeoutMs) {
        if (spawnError !== undefined || exit !== undefined) {
          throw new Error(
            `Vite exited before readiness: ${JSON.stringify(diagnostics(startedAt, lastStatus))}`,
          );
        }
        if (origin !== undefined) {
          try {
            const response = await fetch(origin, {
              signal: AbortSignal.timeout(requestTimeoutMs),
            });
            lastStatus = response.status;
            await response.body?.cancel();
            if (response.ok) {
              return { origin: origin.replace(/\/$/, ''), elapsedMs: Date.now() - startedAt };
            }
          } catch {
            // Vite advertised its origin but has not completed the HTTP response.
          }
        }
        await sleep(pollIntervalMs);
      }
      throw new Error(
        `Vite did not become HTTP-ready: ${JSON.stringify(diagnostics(startedAt, lastStatus))}`,
      );
    },
  };
}
