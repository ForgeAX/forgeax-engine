import { writeSync } from 'node:fs';
import { inspect } from 'node:util';

/** Best-effort internal diagnostics must never change startup or disposal outcomes. */
export function logBackendStartup(
  record: Readonly<Record<string, string | number | undefined>>,
  descriptor = 2,
): void {
  try {
    writeSync(descriptor, `${JSON.stringify({ scope: 'backend-startup', ...record })}\n`);
  } catch {
    // Startup ownership and its original error remain authoritative if logging fails.
  }
}

/** Internal daemon diagnostics; ordinary API/CLI consumers keep their existing output. */
export async function traceBackendStartup<T>(
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.argv[2] !== '--__forgeax-backend') return operation();
  const started = performance.now();
  const log = (event: 'begin' | 'end') => {
    logBackendStartup({ stage, event, elapsedMs: performance.now() - started });
  };
  log('begin');
  try {
    return await operation();
  } catch (cause) {
    try {
      logBackendStartup({
        stage,
        event: 'failed',
        elapsedMs: performance.now() - started,
        // Node's existing diagnostic formatter preserves typed/nested causes.
        // Do not execute author getters or custom inspection hooks while logging.
        error: inspect(cause, {
          depth: 4,
          maxArrayLength: 32,
          maxStringLength: 2000,
          customInspect: false,
          getters: false,
          breakLength: Infinity,
        }).slice(0, 16384),
      });
    } catch {
      // Diagnostic failure must never replace the original operation's reason.
    }
    throw cause;
  } finally {
    log('end');
  }
}
