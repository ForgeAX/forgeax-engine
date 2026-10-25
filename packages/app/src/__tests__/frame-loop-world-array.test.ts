import { testPlatform } from './platform-fixture';
// feat-20260708-composited-multi-world-rendering M3 / m3-t3 — AC-03 frame-loop
// [world] wrapping.
//
// The app frame-loop is the single point that shields single-world AI users from
// the multi-world draw signature: internally it wraps the current World into
// `[world]` and passes `{ cameraOwner: 0, resourceOwner: 0 }` (plan-strategy §7 M3). Engine.create /
// createApp public API is unchanged — the user still hands over one World.
//
// This test drives createFrameLoop directly (injected now / raf / caf seams) with
// a spy renderer and asserts the exact call shape:
//   renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })
//
// Test-first (red before m3-i3): the frame-loop currently calls
// renderer.draw(world). After migration these assertions pass and the single
// world identity path (worldId 0) is preserved (AC-03 regression guarantee).

import { Update, World } from '@forgeax/engine-ecs';
import type { FrameReceipt, Renderer, RenderWorldLease } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';

interface DrawCall {
  readonly request: unknown;
}

function lease(onDispose: () => void = () => {}): RenderWorldLease {
  return {
    worldIdentity: {},
    generation: 0,
    readChanges: vi.fn(),
    querySpans: vi.fn(),
    inspectCursor: vi.fn(),
    dispose: onDispose,
  } as unknown as RenderWorldLease;
}

function completeReceipt(frameId: number): FrameReceipt {
  const completed = {
    // biome-ignore lint/suspicious/noThenProperty: synchronous test completion keeps pump() deterministic.
    then(onFulfilled: (value: { ok: true; value: undefined }) => void): void {
      onFulfilled({ ok: true, value: undefined });
    },
  } as unknown as FrameReceipt['completed'];
  return {
    frameId,
    deviceGeneration: 0,
    presentation: 'ready',
    completed,
  };
}

function makeSpyRenderer(): { renderer: Renderer; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const renderer = {
    state: () => 'alive' as const,
    backend: 'webgpu' as const,
    attach(): { ok: true; value: RenderWorldLease } {
      return { ok: true, value: lease() };
    },
    draw(request: unknown): {
      ok: true;
      value: FrameReceipt;
    } {
      calls.push({ request });
      return { ok: true, value: completeReceipt(calls.length) };
    },
    onError(): () => void {
      return () => {
        // no-op unsubscribe
      };
    },
    dispose(): void {
      // no-op
    },
  } as unknown as Renderer;
  return { renderer, calls };
}

/**
 * Synchronous rAF driver: fire the scheduled tick exactly `frames` times.
 * The injected `raf` stores the next callback; `pump` invokes it, which in
 * turn schedules the following one, so we can step the loop deterministically.
 */
function makeSyncScheduler() {
  let pending: ((t: number) => void) | null = null;
  let clock = 0;
  const raf = (cb: (t: number) => void): number => {
    pending = cb;
    return 1;
  };
  const caf = (): void => {
    pending = null;
  };
  const now = (): number => {
    clock += 16;
    return clock;
  };
  const pump = (frames: number): void => {
    for (let i = 0; i < frames; i++) {
      const cb = pending;
      pending = null;
      if (cb === null) break;
      cb(clock);
    }
  };
  return { raf, caf, now, pump };
}

describe('M3 / m3-t3 — frame-loop wraps the single World into [world] with owner 0', () => {
  it.each([
    undefined,
    'automatic',
    'direct',
  ] as const)('retains the geometry lane across primary, injected and scene-free draws: %s', (geometryLane) => {
    const world = new World();
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
      ...(geometryLane === undefined ? {} : { geometryLane }),
    });
    loop.start().unwrap();
    try {
      pump(1);
      loop.setDrawSource(() => ({ worlds: [world], cameraOwner: 0, resourceOwner: 0 }));
      pump(1);
      loop.setDrawSource(() => null);
      pump(1);
      expect(calls).toHaveLength(3);
      for (const { request } of calls) {
        if (geometryLane === undefined) expect(request).not.toHaveProperty('geometryLane');
        else expect(request).toHaveProperty('geometryLane', geometryLane);
      }
    } finally {
      loop.stop().unwrap();
    }
  });

  it('attaches once before the first update without moving drawSource ahead of update', () => {
    const events: string[] = [];
    const world = new World();
    world
      .addSystem(Update, {
        name: 'observeUpdateOrder',
        queries: [],
        fn: () => events.push('update'),
      })
      .unwrap();
    const renderer = {
      state: () => 'alive' as const,
      backend: 'webgpu' as const,
      attach(): { ok: true; value: RenderWorldLease } {
        events.push('attach');
        return { ok: true, value: lease() };
      },
      draw(): { ok: true; value: FrameReceipt } {
        events.push('draw');
        return { ok: true, value: completeReceipt(1) };
      },
      onError: () => () => {},
      dispose: () => {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      drawSource: () => {
        events.push('drawSource');
        return undefined;
      },
      platform: testPlatform({ now, raf, caf }),
    });

    loop.start().unwrap();
    pump(2);
    loop.stop().unwrap();

    expect(events).toEqual([
      'attach',
      'update',
      'drawSource',
      'draw',
      'update',
      'drawSource',
      'draw',
    ]);
  });

  it('calls renderer.draw with one lease-bound world per running frame', () => {
    const world = new World();
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now, pump } = makeSyncScheduler();

    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
    });
    const started = loop.start();
    expect(started.ok).toBe(true);

    // start() schedules the first tick via raf (it does not run synchronously);
    // pump three ticks so we observe 3 frames total.
    pump(3);

    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.request).toMatchObject({
        leases: [{ worldIdentity: expect.any(Object) }],
        camera: { lease: expect.any(Object) },
        environment: { lease: expect.any(Object) },
      });
    }

    loop.stop();
  });

  it('does not draw a World whose update did not reach terminal publication', () => {
    const world = new World();
    world
      .addSystem(Update, {
        name: 'fail-update',
        queries: [],
        fn: () => {
          throw new Error('update failed');
        },
      })
      .unwrap();
    const { renderer, calls } = makeSpyRenderer();
    const onError = vi.fn();
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      onError,
      platform: testPlatform({ now, raf, caf }),
    });

    loop.start().unwrap();
    pump(1);

    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    loop.stop().unwrap();
  });

  it('does not mutate the public frame-loop contract: start/stop return Result.ok', () => {
    const world = new World();
    const { renderer } = makeSpyRenderer();
    const { raf, caf, now } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
    });

    const started = loop.start();
    expect(started.ok).toBe(true);
    const stopped = loop.stop();
    expect(stopped.ok).toBe(true);
  });

  it('forwards a draw Result.err through onError (single world path unchanged)', () => {
    const world = new World();
    const calls: DrawCall[] = [];
    const rhiErr = { code: 'rhi-not-available' } as const;
    const renderer = {
      state: () => 'alive' as const,
      backend: 'webgpu' as const,
      attach: () => ({ ok: true as const, value: lease() }),
      draw(request: unknown): { ok: false; error: typeof rhiErr } {
        calls.push({ request });
        return { ok: false, error: rhiErr };
      },
      onError(): () => void {
        return () => {
          // no-op
        };
      },
      dispose(): void {
        // no-op
      },
    } as unknown as Renderer;
    const onError = vi.fn();
    const { raf, caf, now, pump } = makeSyncScheduler();

    const loop = createFrameLoop({
      world,
      renderer,
      onError,
      platform: testPlatform({ now, raf, caf }),
    });
    loop.start();
    // start() schedules the first tick via raf; pump once to run it.
    pump(1);

    expect(calls[0]?.request).toMatchObject({
      camera: { lease: expect.any(Object) },
      environment: { lease: expect.any(Object) },
    });
    expect(onError).toHaveBeenCalledWith(rhiErr);

    loop.stop();
  });

  it('keeps the rAF heartbeat and submits receipt-bound frames', () => {
    const world = new World();
    const calls: unknown[] = [];
    const renderer = {
      state: () => 'alive' as const,
      backend: 'webgpu' as const,
      attach: () => ({ ok: true as const, value: lease() }),
      draw(): { ok: true; value: FrameReceipt } {
        calls.push(undefined);
        return { ok: true, value: completeReceipt(calls.length) };
      },
      onError(): () => void {
        return () => {};
      },
      dispose(): void {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
    });
    loop.start();
    pump(1);
    expect(calls).toHaveLength(1);
    pump(3);
    expect(calls).toHaveLength(4);
    loop.stop();
  });

  it('steps one deterministic frame through the same update and draw authority while paused', () => {
    const world = new World();
    const update = vi.spyOn(world, 'update');
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
    });

    expect(loop.start().ok).toBe(true);
    expect(loop.pause().ok).toBe(true);
    const stepped = loop.stepFrame(1 / 60);

    expect(stepped.ok).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(1 / 60);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toMatchObject({
      leases: [{ worldIdentity: expect.any(Object) }],
      camera: { lease: expect.any(Object) },
      environment: { lease: expect.any(Object) },
    });

    expect(loop.resume().ok).toBe(true);
    expect(loop.stop().ok).toBe(true);
  });

  it('steps update-only frames without drawing or receipt credit, then resets the next picture', () => {
    const world = new World();
    const update = vi.spyOn(world, 'update');
    const beforeDraw = vi.fn();
    const calls: DrawCall[] = [];
    // Receipts never complete: once the in-flight credit is spent, only update-only steps run.
    const renderer = {
      ...makeSpyRenderer().renderer,
      draw(request: unknown) {
        calls.push({ request });
        return {
          ok: true,
          value: { ...completeReceipt(calls.length), completed: new Promise(() => {}) },
        };
      },
    } as unknown as Renderer;
    const { raf, caf, now } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
      beforeDraw,
    });
    loop.start().unwrap();
    loop.pause().unwrap();
    while (loop.stepFrame(0.05).ok);
    const drawn = calls.length;
    const updated = update.mock.calls.length;
    expect(loop.stepFrame(0.05)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'credit' } },
    });
    for (let step = 0; step < 3; step++) loop.stepFrame(0.05, false).unwrap();
    expect(calls).toHaveLength(drawn);
    expect(update.mock.calls.slice(updated)).toEqual([[0.05], [0.05], [0.05]]);
    expect(beforeDraw).toHaveBeenCalledTimes(drawn + 3);
    expect(loop.stepFrame(-1, false)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'delta' } },
    });
    loop.stop().unwrap();

    // With credit available, the first drawn picture after skipped steps resets
    // temporal history at the sample time those steps advanced.
    const synced = makeSpyRenderer();
    const next = createFrameLoop({
      world: new World(),
      renderer: synced.renderer,
      platform: testPlatform(makeSyncScheduler()),
    });
    next.start().unwrap();
    next.pause().unwrap();
    next.stepFrame(0.05).unwrap();
    next.stepFrame(0.05, false).unwrap();
    next.stepFrame(0.05, false).unwrap();
    next.stepFrame(0.05).unwrap();
    expect(synced.calls).toHaveLength(2);
    const [a, b] = synced.calls.map(
      ({ request }) => request as { sampleTimeSeconds: number; temporalReset?: boolean },
    );
    expect(b?.temporalReset).toBe(true);
    expect((b?.sampleTimeSeconds ?? 0) - (a?.sampleTimeSeconds ?? 0)).toBeCloseTo(0.15, 9);
    next.stop().unwrap();
  });

  it('rejects deterministic stepping outside paused state and with an invalid delta', () => {
    const world = new World();
    const { renderer } = makeSpyRenderer();
    const { raf, caf, now } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
    });

    const idle = loop.stepFrame(1 / 60);
    expect(idle.ok).toBe(false);
    if (!idle.ok) {
      expect(idle.error.code).toBe('app-frame-step-invalid');
      if ('detail' in idle.error) {
        expect(idle.error.detail).toEqual({ state: 'idle', deltaSeconds: 1 / 60, reason: 'state' });
      }
    }

    expect(loop.start().ok).toBe(true);
    expect(loop.pause().ok).toBe(true);
    const invalidDelta = loop.stepFrame(Number.NaN);
    expect(invalidDelta.ok).toBe(false);
    if (!invalidDelta.ok) {
      expect(invalidDelta.error).toMatchObject({
        code: 'app-frame-step-invalid',
        detail: { reason: 'delta' },
      });
    }
    expect(loop.resume().ok).toBe(true);
    expect(loop.stop().ok).toBe(true);
  });

  it('detaches draw-source Worlds as soon as routing stops referencing them', () => {
    const world = new World();
    const overlay = new World();
    const attached: World[] = [];
    const detached: World[] = [];
    const renderer = {
      state: () => 'alive' as const,
      backend: 'webgpu' as const,
      attach(candidate: World) {
        attached.push(candidate);
        return { ok: true as const, value: lease(() => detached.push(candidate)) };
      },
      draw: () => ({
        ok: true as const,
        value: completeReceipt(1),
      }),
      onError: () => () => {},
      dispose: () => {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      drawSource: () => ({ worlds: [world, overlay], cameraOwner: 0, resourceOwner: 0 }),
      platform: testPlatform({ now, raf, caf }),
    });

    loop.start().unwrap();
    pump(2);
    expect(attached).toEqual([world, overlay]);
    expect(detached).toEqual([]);

    loop.setDrawSource(undefined);
    expect(detached).toEqual([overlay]);
    loop.stop().unwrap();
    expect(detached).toEqual([overlay, world]);
  });

  it('detaches active draw-source Worlds when the loop stops', () => {
    const world = new World();
    const overlay = new World();
    const detached: World[] = [];
    const renderer = {
      state: () => 'alive' as const,
      backend: 'webgpu' as const,
      attach: (candidate: World) => ({
        ok: true as const,
        value: lease(() => detached.push(candidate)),
      }),
      draw: () => ({
        ok: true as const,
        value: completeReceipt(1),
      }),
      onError: () => () => {},
      dispose: () => {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      drawSource: () => ({ worlds: [world, overlay], cameraOwner: 0, resourceOwner: 0 }),
      platform: testPlatform({ now, raf, caf }),
    });

    loop.start().unwrap();
    pump(1);
    loop.stop().unwrap();

    expect(detached).toEqual([overlay, world]);
  });

  it('terminates a paused loop and detaches its primary World exactly once', () => {
    const world = new World();
    const detached: World[] = [];
    const renderer = {
      state: () => 'alive' as const,
      backend: 'webgpu' as const,
      attach: (candidate: World) => ({
        ok: true as const,
        value: lease(() => detached.push(candidate)),
      }),
      draw: () => ({
        ok: true as const,
        value: completeReceipt(1),
      }),
      onError: () => () => {},
      dispose: () => {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
    });

    loop.start().unwrap();
    pump(1);
    loop.pause().unwrap();
    loop.stop().unwrap();

    expect(loop.getState()).toBe('stopped');
    expect(detached).toEqual([world]);
  });

  it('terminal setStopped releases attachments once across repeated cleanup', () => {
    const world = new World();
    const detached: World[] = [];
    const renderer = {
      state: () => 'alive' as const,
      backend: 'webgpu' as const,
      attach: (candidate: World) => ({
        ok: true as const,
        value: lease(() => detached.push(candidate)),
      }),
      draw: () => ({
        ok: true as const,
        value: completeReceipt(1),
      }),
      onError: () => () => {},
      dispose: () => {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
    });

    loop.start().unwrap();
    pump(1);
    loop.setStopped();
    loop.setStopped();

    expect(loop.getState()).toBe('stopped');
    expect(detached).toEqual([world]);
  });
});
