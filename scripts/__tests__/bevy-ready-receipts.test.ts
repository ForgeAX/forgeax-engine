import { expect, it } from 'vitest';

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
