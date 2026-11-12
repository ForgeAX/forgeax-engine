/**
 * Scope a combined cancellation signal to an operation without AbortSignal.any.
 * Keep this function self-contained: DevKit embeds it before Engine modules load.
 */
export async function withCombinedSignal<T>(
  signals: readonly AbortSignal[],
  operation: (signal: AbortSignal) => T | PromiseLike<T>,
): Promise<T> {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const release = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.clear();
  };
  try {
    const aborted = signals.find((signal) => signal.aborted);
    if (aborted) controller.abort(aborted.reason);
    else {
      for (const signal of new Set(signals)) {
        const listener = () => {
          release();
          controller.abort(signal.reason);
        };
        listeners.set(signal, listener);
        signal.addEventListener('abort', listener, { once: true });
      }
    }
    return await operation(controller.signal);
  } finally {
    release();
  }
}
