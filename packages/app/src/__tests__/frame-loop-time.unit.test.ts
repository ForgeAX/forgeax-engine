import { FixedTime, FixedUpdate, Time, World } from '@forgeax/engine-ecs';
import type { FrameReceipt, Renderer, RenderFrameInput } from '@forgeax/engine-render';
import { RendererOperationError } from '@forgeax/engine-render';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { testPlatform } from './platform-fixture';

function renderer(): Renderer {
  return {
    state: () => 'alive' as const,
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    attach: () => ({ ok: true, value: undefined }),
    detachWorld: () => {},
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => {},
    onLost: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

function scheduler() {
  let callback: ((timestamp: number) => void) | undefined;
  return {
    raf: (next: (timestamp: number) => void): number => {
      callback = next;
      return 1;
    },
    caf: (): void => {
      callback = undefined;
    },
    tick(timestamp: number): void {
      const next = callback;
      callback = undefined;
      next?.(timestamp);
    },
  };
}

function deferredReceipt(frameId: number): {
  readonly receipt: FrameReceipt;
  readonly settle: () => void;
  readonly reject: (cause: unknown) => void;
} {
  let resolve!: (value: Awaited<FrameReceipt['completed']>) => void;
  let reject!: (cause: unknown) => void;
  const completed = new Promise<Awaited<FrameReceipt['completed']>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    receipt: {
      frameId,
      deviceGeneration: 0,
      presentation: 'ready',
      completed,
    },
    settle: () => resolve({ ok: true, value: undefined }),
    reject,
  };
}

function failedReceipt(frameId: number): {
  readonly receipt: FrameReceipt;
  readonly settle: () => void;
} {
  let resolve!: (value: Awaited<FrameReceipt['completed']>) => void;
  const completed = new Promise<Awaited<FrameReceipt['completed']>>((res) => {
    resolve = res;
  });
  return {
    receipt: {
      frameId,
      deviceGeneration: 0,
      presentation: 'ready',
      completed,
    },
    settle: () =>
      resolve({
        ok: false,
        error: new RendererOperationError('renderer-state-invalid', {
          state: 'disposed',
          operation: 'draw',
        }),
      }),
  };
}

function receiptRenderer(draw: () => { ok: true; value: FrameReceipt }): Renderer {
  return {
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    attach: () => ({ ok: true, value: { dispose: () => {} } }),
    detachWorld: () => {},
    draw,
    onError: () => () => {},
    onLost: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

describe('frame-loop Time forwarding', () => {
  it('starts a new temporal baseline when a scene returns after UI-only frames', async () => {
    const clock = scheduler();
    const requests: RenderFrameInput[] = [];
    const draw = (input: RenderFrameInput) => {
      requests.push(input);
      return ok({
        frameId: requests.length,
        deviceGeneration: 0,
        presentation: input.camera === null ? ('pending' as const) : ('ready' as const),
        completed: Promise.resolve(ok(undefined)),
      });
    };
    const loop = createFrameLoop({
      world: new World(),
      renderer: receiptRenderer(draw as unknown as () => { ok: true; value: FrameReceipt }),
      platform: testPlatform({ now: () => 1000, raf: clock.raf, caf: clock.caf }),
    });
    loop.start().unwrap();
    clock.tick(1000);
    await loop.drainFrameReceipts();
    loop.setDrawSource(() => null);
    clock.tick(1016);
    await loop.drainFrameReceipts();
    loop.setDrawSource(undefined);
    clock.tick(1032);
    await loop.drainFrameReceipts();
    clock.tick(1048);
    await loop.drainFrameReceipts();
    expect(requests.map((request) => request.temporalReset === true)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(requests[1]?.camera).toBeNull();
    loop.stop().unwrap();
  });

  it('marks the first frame after pause/resume as a temporal baseline', () => {
    const world = new World();
    const clock = scheduler();
    const resets: boolean[] = [];
    let frameId = 0;
    const draw = vi.fn((input: RenderFrameInput) => {
      resets.push(input.temporalReset === true);
      return ok({
        frameId: ++frameId,
        deviceGeneration: 0,
        completed: Promise.resolve(ok(undefined)),
      });
    });
    const loop = createFrameLoop({
      world,
      renderer: receiptRenderer(draw as unknown as () => { ok: true; value: FrameReceipt }),
      platform: testPlatform({ now: () => 1000, raf: clock.raf, caf: clock.caf }),
    });

    loop.start().unwrap();
    clock.tick(1000);
    loop.pause().unwrap();
    loop.resume().unwrap();
    clock.tick(1000);

    expect(resets).toEqual([false, true]);
    loop.stop().unwrap();
  });

  it('keeps the raw render sample clock transactional across a failed submit', () => {
    const own = new World();
    const clock = scheduler();
    const sampleTimes: number[] = [];
    let drawCount = 0;
    const draw = vi.fn((input: RenderFrameInput) => {
      sampleTimes.push(input.sampleTimeSeconds ?? -1);
      drawCount += 1;
      if (drawCount === 1) {
        return err({
          code: 'render-feature-stage-failed',
          expected: 'the submitted frame reaches the queue',
          hint: 'retry the frame after repairing the failed submit',
          detail: {
            featureIdentity: 'test',
            order: -1,
            stage: 'record',
            recovery: 'next-frame',
          },
        } as never);
      }
      return ok({
        frameId: 1,
        deviceGeneration: 0,
        completed: Promise.resolve(ok(undefined)),
      });
    });
    const loop = createFrameLoop({
      world: own,
      renderer: receiptRenderer(draw as unknown as () => { ok: true; value: FrameReceipt }),
      platform: testPlatform({ now: () => 1000, raf: clock.raf, caf: clock.caf }),
    });

    loop.start().unwrap();
    loop.pause().unwrap();
    expect(loop.stepFrame(0.2).ok).toBe(false);
    expect(loop.stepFrame(1 / 60).ok).toBe(true);

    expect(sampleTimes).toEqual([1.2, 1 + 1 / 60]);
    loop.stop().unwrap();
  });

  it.each([
    [60, 1],
    [30, 1],
    [60, 2],
    [60, 3],
  ])('preserves simulated time at %i Hz with receipts settling every %i ticks', async (hz, cadence) => {
    // ai-weapon-spirit: slow GPU receipts must not slow the game clock.
    const world = new World();
    const injected = new World();
    world.addSystem(FixedUpdate, { name: 'clock-probe', queries: [], fn: () => {} }).unwrap();
    const clock = scheduler();
    const pending: ReturnType<typeof deferredReceipt>[] = [];
    let timestamp = 0;
    let frameId = 0;
    const onError = vi.fn();
    const loop = createFrameLoop({
      world,
      renderer: receiptRenderer(() => {
        const frame = deferredReceipt(++frameId);
        pending.push(frame);
        return { ok: true, value: frame.receipt };
      }),
      drawSource: () => ({ worlds: [world, injected], cameraOwner: 0, resourceOwner: 0 }),
      onError,
      platform: testPlatform({ now: () => timestamp, raf: clock.raf, caf: clock.caf }),
    });
    loop.start().unwrap();
    for (let tick = 1; tick <= hz * 10; tick++) {
      // Both completion jobs and Host callbacks observe this tick's real time.
      timestamp = (tick * 1000) / hz;
      if (tick % cadence === 0) {
        pending.shift()?.settle();
        await Promise.resolve();
      }
      clock.tick(timestamp);
    }
    loop.stop().unwrap();
    for (const receipt of pending) receipt.settle();
    await loop.drainFrameReceipts();

    expect(onError).not.toHaveBeenCalled();
    expect(loop.inspect().highWater).toBeLessThanOrEqual(2);
    expect(loop.inspect().throttledTicks > 0).toBe(cadence > 1);
    expect(world.getResource(Time).elapsed).toBeCloseTo(10, 8);
    expect(injected.getResource(Time).elapsed).toBeCloseTo(10, 8);
    expect(world.getResource(FixedTime).tick).toBeGreaterThanOrEqual(599);
    expect(world.getResource(FixedTime).droppedSeconds).toBe(0);
  });

  it('forwards one measured delta to own and injected Worlds', () => {
    const own = new World();
    const injected = new World();
    const clock = scheduler();
    const loop = createFrameLoop({
      world: own,
      renderer: renderer(),
      drawSource: () => ({ worlds: [own, injected], cameraOwner: 0, resourceOwner: 0 }),
      platform: testPlatform({
        now: (() => {
          const values = [1000, 1016];
          return () => values.shift() ?? 1016;
        })(),
        raf: clock.raf,
        caf: clock.caf,
      }),
    });

    loop.start().unwrap();
    clock.tick(1016);

    expect(own.getResource(Time).delta).toBeCloseTo(0.016);
    expect(injected.getResource(Time).delta).toBeCloseTo(0.016);
  });

  it('limits ordinary frames to two in-flight receipts and reports throttle/settle counts', async () => {
    const own = new World();
    const clock = scheduler();
    const first = deferredReceipt(1);
    const second = deferredReceipt(2);
    const third = deferredReceipt(3);
    const receipts = [first, second, third] as const;
    let drawIndex = 0;
    const draw = vi.fn(() => {
      const receipt = receipts[drawIndex++];
      if (receipt === undefined) throw new Error('test renderer ran out of receipts');
      return { ok: true as const, value: receipt.receipt };
    });
    const loop = createFrameLoop({
      world: own,
      renderer: receiptRenderer(draw),
      platform: testPlatform({ now: () => 1000, raf: clock.raf, caf: clock.caf }),
    });

    loop.start().unwrap();
    clock.tick(1016);
    clock.tick(1032);
    clock.tick(1048);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(loop.inspect()).toEqual({
      submitted: 2,
      completed: 0,
      inFlight: 2,
      highWater: 2,
      throttledTicks: 1,
    });

    first.settle();
    await Promise.resolve();
    expect(loop.inspect()).toMatchObject({ submitted: 3, completed: 1, inFlight: 2 });
    clock.tick(1064);
    expect(draw).toHaveBeenCalledTimes(3);
    expect(loop.inspect()).toMatchObject({ submitted: 3, completed: 1, inFlight: 2 });
    loop.stop().unwrap();
  });

  it('settles rejected receipts and routes the failure without an unhandled rejection', async () => {
    const own = new World();
    const clock = scheduler();
    const first = deferredReceipt(1);
    const second = deferredReceipt(2);
    const pending = [first, second] as const;
    let drawIndex = 0;
    const onError = vi.fn();
    const draw = vi.fn(() => {
      const receipt = pending[drawIndex++];
      if (receipt === undefined) throw new Error('test renderer ran out of receipts');
      return { ok: true as const, value: receipt.receipt };
    });
    const loop = createFrameLoop({
      world: own,
      renderer: receiptRenderer(draw),
      onError,
      platform: testPlatform({ now: () => 1000, raf: clock.raf, caf: clock.caf }),
    });

    loop.start().unwrap();
    clock.tick(1016);
    clock.tick(1032);
    second.reject(new Error('queue completion failed'));
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'app-system-update-failed' });
    expect(loop.inspect()).toEqual({
      submitted: 2,
      completed: 1,
      inFlight: 1,
      highWater: 2,
      throttledTicks: 0,
    });
    first.settle();
    await Promise.resolve();
    expect(loop.inspect()).toMatchObject({ submitted: 2, completed: 2, inFlight: 0 });
    loop.stop().unwrap();
  });

  it('does not publish completion for a fulfilled failed receipt Result', async () => {
    const own = new World();
    const clock = scheduler();
    const failed = failedReceipt(1);
    const onError = vi.fn();
    const onCompleted = vi.fn();
    const loop = createFrameLoop({
      world: own,
      renderer: receiptRenderer(() => ({ ok: true, value: failed.receipt })),
      onError,
      onCompleted,
      platform: testPlatform({ now: () => 1000, raf: clock.raf, caf: clock.caf }),
    });

    loop.start().unwrap();
    clock.tick(1016);
    failed.settle();
    await Promise.resolve();

    expect(onCompleted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'renderer-state-invalid' });
    expect(loop.inspect()).toMatchObject({ submitted: 1, completed: 1, inFlight: 0 });
    loop.stop().unwrap();
  });

  it('rejects forged draw values instead of publishing a submitted receipt', () => {
    const own = new World();
    const clock = scheduler();
    const onError = vi.fn();
    const forged = {
      frameId: 'not-a-frame',
      deviceGeneration: 0,
      completed: Promise.resolve({ ok: true as const, value: undefined }),
    };
    const forgedReceipt = forged as unknown as FrameReceipt;
    const loop = createFrameLoop({
      world: own,
      renderer: receiptRenderer(() => ({ ok: true, value: forgedReceipt })),
      onError,
      platform: testPlatform({ now: () => 1000, raf: clock.raf, caf: clock.caf }),
    });

    loop.start().unwrap();
    clock.tick(1016);

    expect(loop.inspect()).toMatchObject({ submitted: 0, completed: 0, inFlight: 0 });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('drains all pending frame receipts without changing credit accounting', async () => {
    const own = new World();
    const clock = scheduler();
    const first = deferredReceipt(1);
    const second = deferredReceipt(2);
    let drawIndex = 0;
    const receipts = [first, second] as const;
    const loop = createFrameLoop({
      world: own,
      renderer: receiptRenderer(() => {
        const receipt = receipts[drawIndex++];
        if (receipt === undefined) throw new Error('renderer ran out of test receipts');
        return { ok: true as const, value: receipt.receipt };
      }),
      platform: testPlatform({ now: () => 1000, raf: clock.raf, caf: clock.caf }),
    });

    loop.start().unwrap();
    clock.tick(1016);
    clock.tick(1032);
    const drained = loop.drainFrameReceipts();
    let settled = false;
    void drained.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    first.settle();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.settle();
    await drained;
    expect(settled).toBe(true);
    expect(loop.inspect()).toMatchObject({ submitted: 2, completed: 2, inFlight: 0 });
    loop.stop().unwrap();
  });
});
