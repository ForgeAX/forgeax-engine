import { withLocalGpuLease } from '../ci/local-gpu-lease.mjs';

/** Admit one complete GPU owner; source/build preparation stays outside. */
export async function sdkGpuStage(label, operation) {
  const run = () => sdkStage(label, operation);
  return process.env.FORGEAX_LOCAL_GPU_LEASE === '1'
    ? withLocalGpuLease(run, { label: `SDK ${label}` })
    : run();
}

/** Stage progress goes to stderr; the final SDK JSON remains machine-readable. */
export async function sdkStage(label, operation, timeoutMs) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  console.error(`[sdk] start ${label}`);
  const heartbeat = setInterval(() => {
    console.error(`[sdk] running ${label} elapsedMs=${elapsed()}`);
  }, 30_000);
  heartbeat.unref();
  let timeout;
  try {
    const pending = Promise.resolve().then(operation);
    const result = await (timeoutMs === undefined
      ? pending
      : Promise.race([
          pending,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
          }),
        ]));
    console.error(`[sdk] complete ${label} elapsedMs=${elapsed()}`);
    return result;
  } catch (error) {
    console.error(
      `[sdk] failed ${label} elapsedMs=${elapsed()} code=${error?.code ?? error?.name ?? typeof error} signal=${error?.signal ?? 'none'}`,
    );
    for (const channel of ['stdout', 'stderr']) {
      if (error?.[channel])
        console.error(`[sdk] ${channel} tail:\n${String(error[channel]).slice(-8000)}`);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
  }
}
