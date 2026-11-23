/** Shared defaults for source preparation and generated browser execution. */
export const DEV_PREPARATION_TIMEOUT_MS = 30 * 60_000;
export const DEV_EXECUTION_TIMEOUT_MS = 120_000;

/** Bound the caller's wait while letting the producer own its eventual result. */
export async function beforeDeadline<T, Fallback>(
  work: Promise<T> | (() => Promise<T>),
  timeoutMs: number,
  onTimeout: () => Fallback,
): Promise<T | Fallback> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<Fallback>((resolve, reject) => {
      timer = setTimeout(
        () => void Promise.resolve().then(onTimeout).then(resolve, reject),
        timeoutMs,
      );
    });
    return await Promise.race([typeof work === 'function' ? work() : work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
