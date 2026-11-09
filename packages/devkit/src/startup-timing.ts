import { appendFileSync, writeSync } from 'node:fs';

/** Opt-in intervals; identities/URLs and exception text never enter timing records. */
export async function traceDevStartup<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  if (process.env.FORGEAX_WORKSPACE_TIMING !== '1') return operation();
  const started = performance.now();
  const startedUnixMs = Date.now();
  const cpu = process.cpuUsage();
  let completed = false;
  try {
    const value = await operation();
    completed = true;
    return value;
  } finally {
    const spent = process.cpuUsage(cpu);
    writeStartupRecord('[forgeax.dev-startup.timing]', {
      stage,
      pid: process.pid,
      startedUnixMs,
      elapsedMs: performance.now() - started,
      cpuMs: (spent.user + spent.system) / 1000,
      completed,
    });
  }
}

export function logLiveInputTiming(
  record: Readonly<Record<string, string | number | boolean | undefined>>,
): void {
  if (process.env.FORGEAX_WORKSPACE_TIMING !== '1') return;
  writeStartupRecord('[forgeax.live-inputs.timing]', {
    ...record,
    pid: process.pid,
    observedUnixMs: Date.now(),
  });
}

function writeStartupRecord(
  prefix: string,
  record: Readonly<Record<string, string | number | boolean | undefined>>,
): void {
  try {
    const line = `${prefix} ${JSON.stringify(record)}\n`;
    const destination = process.env.FORGEAX_STARTUP_TIMING_LOG;
    if (destination === undefined) writeSync(2, line);
    else appendFileSync(destination, line, { mode: 0o600 });
  } catch {
    // Diagnostics cannot replace the operation's result or original failure.
  }
}
