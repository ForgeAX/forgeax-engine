import { Time, World } from '@forgeax/engine-ecs';
import type { FrameReceipt, Renderer } from '@forgeax/engine-render';
import { ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createFrameLoop,
  type FrameLoopHandle,
  type FrameLoopOptions,
} from '../internal/frame-loop';
import { testPlatform } from './platform-fixture';

function fixture(
  hooks: {
    hostIntervalMs?: number;
    onCompleted?: (loop: FrameLoopHandle) => void;
    onSubmitted?: (loop: FrameLoopHandle, frame: number) => void;
    onError?: (loop: FrameLoopHandle) => void;
  } = {},
) {
  let time = 0;
  let nextId = 0;
  let rendererState = 'alive';
  let deviceGeneration = 0;
  let clockFailure = false;
  const pending = new Map<number, { due: number; callback: (time: number) => void }>();
  const receipts: { settle(): void; reject(): void }[] = [];
  const starts: number[] = [];
  const errors: unknown[] = [];
  const world = new World();
  let loop: FrameLoopHandle;
  const renderer = {
    state: () => rendererState,
    inspect: () => ({ frame: { deviceGeneration } }),
    attach: () => ok({ dispose() {} }),
    draw: () => {
      starts.push(time);
      time += 6;
      let resolve!: (result: Result<void, never>) => void;
      let reject!: (cause: unknown) => void;
      const completed = new Promise<Result<void, never>>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      receipts.push({
        settle: () => resolve(ok(undefined)),
        reject: () => reject(new Error('native receipt failed')),
      });
      return ok({
        frameId: starts.length,
        deviceGeneration,
        presentation: 'ready',
        completed,
      } satisfies FrameReceipt);
    },
  } as unknown as Renderer;
  loop = createFrameLoop({
    world,
    renderer,
    platform: testPlatform({
      now: () => {
        if (clockFailure) {
          clockFailure = false;
          throw new Error('clock unavailable');
        }
        return time;
      },
      raf: (callback) => {
        const id = ++nextId;
        pending.set(id, { due: time + (hooks.hostIntervalMs ?? 16), callback });
        return id;
      },
      caf: (id) => {
        pending.delete(id);
      },
    }),
    onCompleted: () => hooks.onCompleted?.(loop),
    onSubmitted: () => hooks.onSubmitted?.(loop, starts.length),
    onError: (error) => {
      errors.push(error);
      hooks.onError?.(loop);
    },
  } satisfies FrameLoopOptions);
  const pump = () => {
    const first = [...pending].sort((a, b) => a[1].due - b[1].due)[0];
    if (!first) return;
    pending.delete(first[0]);
    time = Math.max(time, first[1].due);
    first[1].callback(time);
  };
  return {
    loop,
    world,
    starts,
    pending,
    errors,
    receipt: (index: number) => {
      const receipt = receipts[index];
      if (receipt === undefined) throw new Error(`No submitted receipt at index ${index}`);
      return receipt;
    },
    pump,
    now: () => time,
    at: (value: number) => {
      expect(value).toBeGreaterThanOrEqual(time);
      time = value;
    },
    lose: () => {
      rendererState = 'recovering';
    },
    recover: () => {
      rendererState = 'alive';
      deviceGeneration += 1;
    },
    failClock: () => {
      clockFailure = true;
    },
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function saturate(f: ReturnType<typeof fixture>) {
  f.loop.start().unwrap();
  f.pump();
  f.pump();
  f.pump();
  expect(f.starts).toEqual([16, 32]);
  expect(f.loop.inspect()).toMatchObject({ inFlight: 2, throttledTicks: 1, highWater: 2 });
}

describe('a Host frame blocked by receipt credit', () => {
  it('resumes the blocked frame when its real credit returns, without waiting for the next Host callback', async () => {
    const f = fixture();
    saturate(f);
    f.at(51);
    f.receipt(0).settle();
    await flush();
    expect(f.starts).toEqual([16, 32, 51]);
    expect(f.world.getResource(Time).delta).toBeCloseTo(0.019, 8);
    expect(f.world.getResource(Time).elapsed).toBeCloseTo(0.051, 8);
    expect(f.loop.inspect()).toMatchObject({
      submitted: 3,
      completed: 1,
      inFlight: 2,
      highWater: 2,
    });
    expect([...f.pending.values()].map((row) => row.due)).toEqual([64]);
    f.loop.stop().unwrap();
  });

  it('does not add completion-driven frames when no Host callback was throttled', async () => {
    const f = fixture();
    f.loop.start().unwrap();
    f.pump();
    f.at(25);
    f.receipt(0).settle();
    await flush();
    expect(f.starts).toEqual([16]);
    expect(f.pending.size).toBe(1);
    f.pump();
    expect(f.starts).toEqual([16, 32]);
    f.loop.stop().unwrap();
  });

  it('coalesces several blocked callbacks into one resumed frame', async () => {
    const f = fixture();
    saturate(f);
    f.pump();
    f.at(67);
    f.receipt(0).settle();
    f.receipt(1).settle();
    await flush();
    expect(f.starts).toEqual([16, 32, 67]);
    expect(f.pending.size).toBe(1);
    expect(f.loop.inspect()).toMatchObject({
      submitted: 3,
      completed: 2,
      inFlight: 1,
      highWater: 2,
    });
    f.loop.stop().unwrap();
  });

  it.each([
    'pause',
    'stop',
    'setStopped',
  ] as const)('retires the blocked frame on %s', async (action) => {
    const f = fixture();
    saturate(f);
    f.loop[action]();
    f.at(51);
    f.receipt(0).settle();
    await flush();
    expect(f.starts).toEqual([16, 32]);
    expect(f.pending.size).toBe(0);
    if (action === 'pause') f.loop.stop().unwrap();
  });

  it('does not revive a blocked frame across a reentrant pause/resume in completion notification', async () => {
    const f = fixture({
      onCompleted: (loop) => {
        loop.pause().unwrap();
        loop.resume().unwrap();
      },
    });
    saturate(f);
    f.at(51);
    f.receipt(0).settle();
    await flush();
    expect(f.starts).toEqual([16, 32]);
    expect([...f.pending.values()].map((row) => row.due)).toEqual([67]);
    f.pump();
    expect(f.starts).toEqual([16, 32, 67]);
    expect(f.world.getResource(Time).delta).toBeCloseTo(0.016, 8);
    f.loop.stop().unwrap();
  });

  it('cancels the sole reservation when the resumed submission pauses synchronously', async () => {
    const f = fixture({
      onSubmitted: (loop, frame) => {
        if (frame === 3) loop.pause().unwrap();
      },
    });
    saturate(f);
    f.at(51);
    f.receipt(0).settle();
    await flush();
    expect(f.starts).toEqual([16, 32, 51]);
    expect(f.loop.getState()).toBe('paused');
    expect(f.pending.size).toBe(0);
    f.loop.stop().unwrap();
  });

  it('does not wake from a failed receipt or during renderer recovery', async () => {
    const f = fixture();
    saturate(f);
    f.at(51);
    f.receipt(0).reject();
    await flush();
    expect(f.starts).toEqual([16, 32]);
    expect(f.errors).toHaveLength(1);
    f.lose();
    f.receipt(1).settle();
    await flush();
    expect(f.starts).toEqual([16, 32]);
    f.loop.stop().unwrap();
  });

  it('routes a wake clock failure and preserves one reentrant replacement', async () => {
    const f = fixture({
      onError: (loop) => {
        expect(f.pending.size).toBe(0);
        loop.resume().unwrap();
      },
    });
    saturate(f);
    f.at(51);
    f.failClock();
    f.receipt(0).settle();
    await flush();
    expect(f.errors).toHaveLength(1);
    expect(f.starts).toEqual([16, 32]);
    expect([...f.pending.values()].map((row) => row.due)).toEqual([67]);
    f.pump();
    expect(f.starts).toEqual([16, 32, 67]);
    f.loop.stop().unwrap();
  });

  it('does not use an old device generation completion to wake a blocked frame', async () => {
    const f = fixture();
    saturate(f);
    f.recover();
    f.at(51);
    f.receipt(0).settle();
    await flush();
    expect(f.starts).toEqual([16, 32]);
    f.pump();
    expect(f.starts).toEqual([16, 32, 64]);
    f.loop.stop().unwrap();
  });

  it('retires blocked work when a Host callback observes recovery', async () => {
    const f = fixture();
    saturate(f);
    f.lose();
    f.pump();
    f.recover();
    f.at(67);
    f.receipt(0).settle();
    await flush();
    expect(f.starts).toEqual([16, 32]);
    f.pump();
    expect(f.starts).toEqual([16, 32, 80]);
    expect(f.world.getResource(Time).delta).toBeCloseTo(0.016, 8);
    f.loop.stop().unwrap();
  });

  it('consumes blocked work when the next Host callback admits a frame', async () => {
    const f = fixture();
    saturate(f);
    f.at(51);
    f.receipt(0).reject();
    await flush();
    f.pump();
    expect(f.starts).toEqual([16, 32, 64]);
    f.at(73);
    f.receipt(1).settle();
    await flush();
    expect(f.starts).toEqual([16, 32, 64]);
    expect(f.loop.inspect()).toMatchObject({ inFlight: 1, highWater: 2 });
    f.loop.stop().unwrap();
  });

  it('preserves a 30 Hz Host budget under sustained receipt backpressure', async () => {
    const f = fixture({ hostIntervalMs: 1000 / 30 });
    f.loop.start().unwrap();
    let settled = 0;
    let previousThrottled = 0;
    for (let callbackCount = 1; callbackCount <= 120; callbackCount++) {
      f.pump();
      const throttled = f.loop.inspect().throttledTicks;
      if (throttled > previousThrottled) {
        f.at(f.now() + 2);
        f.receipt(settled++).settle();
        await flush();
      }
      previousThrottled = throttled;
      expect(f.starts.length).toBeLessThanOrEqual(callbackCount);
      expect(f.loop.inspect().highWater).toBeLessThanOrEqual(2);
      expect(f.pending.size).toBe(1);
    }
    expect(settled).toBe(118);
    expect(f.starts).toHaveLength(120);
    expect(f.now()).toBeCloseTo(4008, 8);
    f.loop.stop().unwrap();
  });

  it('returns from the completion observer before resuming World and draw', async () => {
    const events: string[] = [];
    const f = fixture({
      onCompleted: (loop) => {
        events.push('complete');
        expect(loop.inspect()).toMatchObject({ submitted: 2, completed: 0, inFlight: 2 });
        events.push('complete-return');
      },
      onSubmitted: (loop, frame) => {
        if (frame !== 3) return;
        events.push('resumed-submit');
        expect(loop.inspect()).toMatchObject({ submitted: 3, completed: 1, inFlight: 2 });
      },
    });
    saturate(f);
    f.at(51);
    f.receipt(0).settle();
    await flush();
    expect(events).toEqual(['complete', 'complete-return', 'resumed-submit']);
    f.loop.stop().unwrap();
  });
});
