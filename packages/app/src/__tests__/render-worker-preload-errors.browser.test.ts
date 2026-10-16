import { expect, it } from 'vitest';

interface Observation {
  readonly kind: string;
  readonly [key: string]: unknown;
}
type PendingWaiter = {
  resolve(value: Observation): void;
  reject(cause: unknown): void;
};
function fixture(mode: string, signal: AbortSignal) {
  const worker = new Worker(
    new URL('./fixtures/render-worker-preload-parent.ts', import.meta.url),
    {
      type: 'module',
      name: 'fixture-engine-error-owner',
    },
  );
  const observations: Observation[] = [];
  const ancestorErrors: string[] = [];
  const waiters = new Map<string, PendingWaiter[]>();
  const errors = new Map<string, Observation>();
  let failure: { readonly cause: unknown } | undefined;
  let terminated = false;
  function terminate(): void {
    signal.removeEventListener('abort', abort);
    if (!terminated) {
      terminated = true;
      worker.terminate();
    }
  }
  function fail(cause: unknown): void {
    failure ??= { cause };
    for (const pending of waiters.values()) {
      for (const waiter of pending) waiter.reject(failure.cause);
    }
    waiters.clear();
  }
  function abort(): void {
    try {
      fail(signal.reason);
    } finally {
      terminate();
    }
  }
  signal.addEventListener('abort', abort, { once: true });
  worker.onmessage = (event: MessageEvent<Observation>) => {
    const value = event.data;
    observations.push(value);
    errors.set(value.kind, value);
    if (value.kind === 'fixture-failed' || value.kind === 'cleanup-failed') {
      fail(Object.assign(new Error(String(value.message)), { observation: value }));
      return;
    }
    for (const waiter of waiters.get(value.kind) ?? []) waiter.resolve(value);
    waiters.delete(value.kind);
  };
  worker.onerror = (event) => {
    // The explicit native negative is expected and retained, not a Game gate bypass.
    ancestorErrors.push(event.message);
    event.preventDefault();
    const value = { kind: 'ancestor-error', message: event.message };
    errors.set(value.kind, value);
    for (const waiter of waiters.get(value.kind) ?? []) waiter.resolve(value);
    waiters.delete(value.kind);
  };
  if (signal.aborted) abort();
  else worker.postMessage({ kind: 'run', mode });
  async function wait(kind: string): Promise<Observation> {
    if (failure !== undefined) throw failure.cause;
    const current = errors.get(kind);
    if (current !== undefined) return current;
    return new Promise((resolve, reject) => {
      const previous = waiters.get(kind) ?? [];
      waiters.set(kind, [...previous, { resolve, reject }]);
    });
  }
  return {
    worker,
    observations,
    ancestorErrors,
    wait,
    terminate,
    isTerminated: () => terminated,
    async close() {
      try {
        if (failure !== undefined) throw failure.cause;
        worker.postMessage({ kind: 'dispose' });
        const cleaned = await wait('cleaned');
        expect(cleaned.gpuCalls).toBe(0);
        expect(
          (cleaned.children as { terminateCalls: number }[]).every(
            (child) => child.terminateCalls >= 1,
          ),
        ).toBe(true);
      } finally {
        terminate();
      }
    },
  };
}
async function withFixture(
  mode: string,
  signal: AbortSignal,
  body: (control: ReturnType<typeof fixture>) => Promise<void>,
): Promise<void> {
  const control = fixture(mode, signal);
  let primary: { readonly cause: unknown } | undefined;
  try {
    await body(control);
  } catch (cause) {
    primary = { cause };
  }
  try {
    await control.close();
  } catch (cleanupCause) {
    if (primary === undefined) throw cleanupCause;
    if (cleanupCause === primary.cause) throw primary.cause;
    // Both raw causes survive: cleanup must not erase the assertion/owner error.
    throw new AggregateError(
      [primary.cause, cleanupCause],
      'Fixture cleanup failed after primary failure',
      {
        cause: primary.cause,
      },
    );
  }
  if (primary !== undefined) throw primary.cause;
}

it('does not let a native nested module error bypass a deferred Native root failure', async ({
  signal,
}) => {
  await withFixture('root-fails', signal, async (control) => {
    await control.wait('root-enter');
    const error = await control.wait('child-error');
    expect(error.cancelable).toBe(true);
    expect(error.defaultPrevented).toBe(true); // RED on uncorrected staged owner.
    expect(control.ancestorErrors).toEqual([]);
    expect(control.observations.some((value) => value.kind === 'terminal')).toBe(false);
    control.worker.postMessage({ kind: 'release-root' });
    const terminal = await control.wait('terminal');
    expect(terminal).toMatchObject({
      parentErrors: 0,
      gpuCalls: 0,
      childCount: 1,
      primary: { code: 'plugin-startup-failed' },
      child: { requestedOptions: { type: 'module', name: 'forgeax-render' }, inputs: [] },
    });
    expect(JSON.stringify(terminal.primary)).toContain('fixture-native-root-failure');
    expect(JSON.stringify(terminal.primary)).not.toContain('fixture-native-module-failure');
    expect(control.ancestorErrors).toEqual([]);
  });
});

it('reports the identical retained native module cause only after a successful Native root', async ({
  signal,
}) => {
  await withFixture('root-succeeds', signal, async (control) => {
    await control.wait('root-enter');
    const error = await control.wait('child-error');
    expect(error.defaultPrevented).toBe(true);
    expect(control.ancestorErrors).toEqual([]);
    expect(control.observations.some((value) => value.kind === 'terminal')).toBe(false);
    control.worker.postMessage({ kind: 'release-root' });
    const terminal = await control.wait('terminal');
    expect(terminal).toMatchObject({
      parentErrors: 0,
      gpuCalls: 0,
      rootActive: true,
      childCount: 1,
      primary: { code: 'render-worker-failed', detail: error.message },
      child: { inputs: [] },
    });
    expect(control.ancestorErrors).toEqual([]);
  });
});

it('exposes uncanceled real nested module errors at the Document owner as a negative control', async ({
  signal,
}) => {
  await withFixture('uncanceled', signal, async (control) => {
    const child = await control.wait('child-error');
    expect(child).toMatchObject({ cancelable: true, defaultPrevented: false });
    const ancestor = await control.wait('ancestor-error');
    expect(String(ancestor.message)).toContain('fixture-native-module-failure');
    expect(control.ancestorErrors.length).toBeGreaterThan(0);
  });
});

it('rejects pending and future waits on the actual fixture-failed channel and terminates in finally', async ({
  signal,
}) => {
  const control = fixture('fixture-fails', signal);
  try {
    await expect(control.wait('root-enter')).rejects.toThrow('fixture-controlled-startup-failure');
    await expect(control.wait('cleaned')).rejects.toThrow('fixture-controlled-startup-failure');
    await expect(control.close()).rejects.toThrow('fixture-controlled-startup-failure');
    expect(control.isTerminated()).toBe(true);
    expect(control.observations).toContainEqual({
      kind: 'fixture-failed',
      message: 'Error: fixture-controlled-startup-failure',
    });
  } finally {
    control.terminate();
  }
});

it('rejects an in-flight cleaned waiter on the actual cleanup-failed channel and terminates', async ({
  signal,
}) => {
  const control = fixture('cleanup-fails', signal);
  try {
    await control.wait('fixture-started');
    await expect(control.close()).rejects.toThrow('fixture-controlled-cleanup-failure');
    expect(control.isTerminated()).toBe(true);
    expect(control.observations).toContainEqual({
      kind: 'cleanup-failed',
      message: 'Error: fixture-controlled-cleanup-failure',
    });
  } finally {
    control.terminate();
  }
});

it('rejects waits and terminates immediately on cancellation without a new fixture deadline', async ({
  signal,
}) => {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', forwardAbort, { once: true });
  if (signal.aborted) forwardAbort();
  const control = fixture('never-replies', controller.signal);
  try {
    await control.wait('fixture-started');
    const pending = control.wait('never');
    const cause = new Error('fixture-controlled-cancellation');
    controller.abort(cause);
    await expect(pending).rejects.toBe(cause);
    await expect(control.close()).rejects.toBe(cause);
    expect(control.isTerminated()).toBe(true);
  } finally {
    signal.removeEventListener('abort', forwardAbort);
    control.terminate();
  }
});
