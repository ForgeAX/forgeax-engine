import { expect, it, vi } from 'vitest';

const { runSmokeAppFrames } = await import(
  new URL('../../apps/bevy/scripts/renderer-smoke.mjs', import.meta.url).href
);

function fixture(receipts: { presentation: string; completed: Promise<unknown> }[][]) {
  let listener: ((event: unknown) => void) | undefined;
  let pumps = 0;
  let stopped = false;
  let subscribed = false;
  const app = {
    renderer: {
      subscribe(callback: (event: unknown) => void) {
        subscribed = true;
        listener = callback;
        return () => {
          subscribed = false;
        };
      },
    },
    start() {
      expect(subscribed).toBe(true);
      return { ok: true };
    },
    stop() {
      stopped = true;
    },
  };
  return {
    app,
    pump() {
      const batch = receipts[pumps++];
      if (!batch) return false;
      for (const receipt of batch) listener?.({ kind: 'frame-submitted', receipt });
      return true;
    },
    state: () => ({ pumps, stopped, subscribed }),
  };
}

it('counts completed ready receipts instead of pending RAF callbacks', async () => {
  const completed = Promise.resolve({ ok: true });
  const test = fixture([
    [{ presentation: 'pending', completed }],
    [{ presentation: 'ready', completed }],
    [{ presentation: 'ready', completed }],
  ]);
  expect(await runSmokeAppFrames(test.app, test.pump, 2)).toBe(2);
  expect(test.state()).toEqual({ pumps: 3, stopped: true, subscribed: false });
});

it('rejects overlapping unconsumed receipts', async () => {
  const receipt = { presentation: 'ready', completed: Promise.resolve({ ok: true }) };
  const test = fixture([[receipt, receipt]]);
  await expect(runSmokeAppFrames(test.app, test.pump, 1)).rejects.toThrow('overlapping');
  expect(test.state()).toEqual({ pumps: 1, stopped: true, subscribed: false });
});

it.each([false, true])('propagates completion failures (rejection=%s)', async (reject) => {
  const error = new Error('actual completion failed');
  const test = fixture([
    [
      {
        presentation: 'ready',
        completed: reject
          ? Promise.resolve().then(() => {
              throw error;
            })
          : Promise.resolve({ ok: false, error }),
      },
    ],
  ]);
  await expect(runSmokeAppFrames(test.app, test.pump, 1)).rejects.toBe(error);
  expect(test.state().stopped).toBe(true);
});

it('fails when the App stops producing RAF callbacks before a ready frame', async () => {
  const test = fixture([]);
  await expect(runSmokeAppFrames(test.app, test.pump, 1)).rejects.toThrow('exhausted');
  expect(test.state().stopped).toBe(true);
});

it('retains the five-second GPU deadline and reports the stalled receipt phase', async () => {
  vi.useFakeTimers();
  try {
    const test = fixture([[{ presentation: 'pending', completed: new Promise(() => {}) }]]);
    const result = runSmokeAppFrames(test.app, test.pump, 60);
    const rejected = expect(result).rejects.toThrow(
      'Smoke GPU frame completion exceeded its credit budget: {"ready":0,"target":60,"presentation":"pending"}',
    );
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(test.state()).toEqual({ pumps: 1, stopped: true, subscribed: false });
  } finally {
    vi.useRealTimers();
  }
});

it('allows the first ready GPU completion to finish cold setup inside the total budget', async () => {
  vi.useFakeTimers();
  try {
    const completed = new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 6000));
    const test = fixture([[{ presentation: 'ready', completed }]]);
    const observed = runSmokeAppFrames(test.app, test.pump, 1).then(
      (value: number) => ({ value }),
      (error: Error) => ({ error: error.message }),
    );
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
    await vi.advanceTimersByTimeAsync(6002);
    expect(await observed).toEqual({ value: 1 });
    expect(test.state()).toEqual({ pumps: 1, stopped: true, subscribed: false });
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the five-second completion bound after the first ready picture', async () => {
  vi.useFakeTimers();
  try {
    const test = fixture([
      [{ presentation: 'ready', completed: Promise.resolve({ ok: true }) }],
      [{ presentation: 'ready', completed: new Promise(() => {}) }],
    ]);
    const result = runSmokeAppFrames(test.app, test.pump, 60);
    const rejected = expect(result).rejects.toThrow('"ready":1,"target":60');
    await vi.waitFor(() => {
      expect(test.state().pumps).toBe(2);
      expect(vi.getTimerCount()).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(test.state()).toEqual({ pumps: 2, stopped: true, subscribed: false });
  } finally {
    vi.useRealTimers();
  }
});

it('rejects a first ready GPU completion that exceeds its cold-start allowance', async () => {
  vi.useFakeTimers();
  try {
    const test = fixture([[{ presentation: 'ready', completed: new Promise(() => {}) }]]);
    let settled = false;
    const result = runSmokeAppFrames(test.app, test.pump, 60).finally(() => {
      settled = true;
    });
    const rejected = expect(result).rejects.toThrow('GPU frame completion exceeded');
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(test.state()).toEqual({ pumps: 1, stopped: true, subscribed: false });
  } finally {
    vi.useRealTimers();
  }
});
