import { World } from '@forgeax/engine-ecs';
import type { FrameReceipt, Renderer } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createFrameLoop, type FrameLoopHandle } from '../internal/frame-loop';
import { testPlatform } from './platform-fixture';

function relativeHost() {
  let time = 0;
  let nextId = 0;
  const pending = new Map<number, { due: number; callback: (time: number) => void }>();
  return {
    pending,
    now: () => time,
    work: (milliseconds: number) => {
      time += milliseconds;
    },
    raf: (callback: (time: number) => void) => {
      const id = ++nextId;
      pending.set(id, { due: time + 16, callback });
      return id;
    },
    caf: (id: number) => {
      pending.delete(id);
    },
    pump: () => {
      const first = [...pending].sort((a, b) => a[1].due - b[1].due)[0];
      if (first === undefined) return;
      pending.delete(first[0]);
      time = Math.max(time, first[1].due);
      first[1].callback(time);
    },
  };
}

function fixture(
  onSubmitted?: (loop: FrameLoopHandle) => void,
  onError?: (loop: FrameLoopHandle) => void,
) {
  const host = relativeHost();
  const drawStarts: number[] = [];
  let loop: FrameLoopHandle;
  const renderer = {
    state: () => 'alive',
    attach: () => ok({ dispose() {} }),
    draw: () => {
      drawStarts.push(host.now());
      host.work(6);
      return ok({
        frameId: drawStarts.length,
        deviceGeneration: 0,
        presentation: 'ready',
        completed: Promise.resolve(ok(undefined)),
      } satisfies FrameReceipt);
    },
  } as unknown as Renderer;
  loop = createFrameLoop({
    world: new World(),
    renderer,
    platform: testPlatform(host),
    onSubmitted: () => onSubmitted?.(loop),
    onError: () => onError?.(loop),
  });
  return { host, drawStarts, loop };
}

describe('frame loop request-relative Host pacing', () => {
  it('keeps frame work inside the requested interval instead of adding it to every interval', async () => {
    const { host, drawStarts, loop } = fixture();
    loop.start().unwrap();
    for (let frame = 0; frame < 3; frame++) {
      host.pump();
      await loop.drainFrameReceipts();
      expect(host.pending.size).toBe(1);
    }
    expect(drawStarts).toEqual([16, 32, 48]);
    loop.stop().unwrap();
    expect(host.pending.size).toBe(0);
  });

  it.each([
    'pause',
    'stop',
    'setStopped',
  ] as const)('cancels the reserved successor when submission calls %s', (action) => {
    const { host, drawStarts, loop } = fixture((value) => value[action]());
    loop.start().unwrap();
    host.pump();
    expect(host.pending.size).toBe(0);
    host.pump();
    expect(drawStarts).toEqual([16]);
    if (action === 'pause') loop.stop().unwrap();
  });

  it('retains exactly one successor when submission pauses and resumes synchronously', async () => {
    let resumed = false;
    const { host, drawStarts, loop } = fixture((value) => {
      if (resumed) return;
      resumed = true;
      value.pause().unwrap();
      value.resume().unwrap();
      value.resume().unwrap();
    });
    loop.start().unwrap();
    host.pump();
    await loop.drainFrameReceipts();
    expect(host.pending.size).toBe(1);
    host.pump();
    await loop.drainFrameReceipts();
    expect(drawStarts).toEqual([16, 38]);
    expect(host.pending.size).toBe(1);
    loop.stop().unwrap();
    expect(host.pending.size).toBe(0);
  });

  it('cancels the successor when reading the frame clock fails', () => {
    const { host, drawStarts, loop } = fixture();
    loop.start().unwrap();
    host.now = () => {
      throw new Error('clock unavailable');
    };
    host.pump();
    expect(loop.getState()).toBe('paused');
    expect(host.pending.size).toBe(0);
    expect(drawStarts).toEqual([]);
    loop.stop().unwrap();
  });

  it('pauses without updating the World when reserving the next frame fails', () => {
    const { host, drawStarts, loop } = fixture();
    loop.start().unwrap();
    host.raf = () => {
      throw new Error('Host scheduling unavailable');
    };
    host.pump();
    expect(loop.getState()).toBe('paused');
    expect(host.pending.size).toBe(0);
    expect(drawStarts).toEqual([]);
    loop.stop().unwrap();
  });

  it('replaces a clock-failed reservation once when onError resumes synchronously', async () => {
    let errors = 0;
    const { host, drawStarts, loop } = fixture(undefined, (value) => {
      errors++;
      expect(host.pending.size).toBe(0);
      value.resume().unwrap();
    });
    loop.start().unwrap();
    const now = host.now;
    let failed = false;
    host.now = () => {
      if (!failed) {
        failed = true;
        throw new Error('transient clock error');
      }
      return now();
    };
    host.pump();
    expect(errors).toBe(1);
    expect(loop.getState()).toBe('running');
    expect(host.pending.size).toBe(1);
    host.pump();
    await loop.drainFrameReceipts();
    expect(drawStarts).toEqual([32]);
    expect(host.pending.size).toBe(1);
    loop.stop().unwrap();
    expect(host.pending.size).toBe(0);
  });
});
