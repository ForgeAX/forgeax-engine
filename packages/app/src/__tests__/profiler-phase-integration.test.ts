import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createProfiler } from '@forgeax/engine-profiler';
import type { Renderer, RenderFrameInput } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { APP_PHASE_CATALOG } from '../types';
import { testPlatform } from './platform-fixture';

function makeScheduler() {
  let callback: ((timestamp: number) => void) | undefined;
  return {
    raf(next: (timestamp: number) => void): number {
      callback = next;
      return 1;
    },
    caf(): void {
      callback = undefined;
    },
    tick(timestamp: number): void {
      const next = callback;
      callback = undefined;
      next?.(timestamp);
    },
  };
}

function makeRenderer(draw: (profileFrame: unknown) => void): Renderer {
  return {
    state: () => 'alive' as const,
    attach: (world: World) => ({ ok: true, value: createRenderReadLease(world) }),
    draw: (request: RenderFrameInput) => {
      draw(request.profileFrame);
      return { ok: true, value: undefined };
    },
    subscribe: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

function start(profiler: ReturnType<typeof createProfiler>) {
  const result = profiler.startCapture({ frameLimit: 2, eventLimit: 64 });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function finish(profiler: ReturnType<typeof createProfiler>) {
  const session = profiler.activeSession();
  if (session === undefined) {
    const latest = profiler.latestCapture();
    if (latest === undefined) throw new Error('capture did not publish');
    return latest;
  }
  const result = session.finish();
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('App and Render profiler integration', () => {
  it('keeps normal and App-only frames on one capture identity', () => {
    const profiler = createProfiler();
    start(profiler);
    const scheduler = makeScheduler();
    const drawOptions: unknown[] = [];
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer((options) => drawOptions.push(options)),
      profiler,
      platform: testPlatform({ now: () => 1000, raf: scheduler.raf, caf: scheduler.caf }),
    });

    loop.start().unwrap();
    scheduler.tick(1000);
    loop.stop().unwrap();

    const capture = finish(profiler);
    expect(capture.records.filter((record) => record.source === 'app')).toHaveLength(5);
    expect(capture.records.every((record) => record.frameId === 1)).toBe(true);
    expect(drawOptions[0]).toMatchObject({
      captureId: capture.captureId,
      frameId: 1,
    });
    expect(capture.phaseCatalog.app).toEqual(APP_PHASE_CATALOG);
    expect(profiler.phaseCatalog.app).toEqual([]);
  });

  it('isolates a renderer failure while the host frame loop continues', () => {
    const profiler = createProfiler();
    start(profiler);
    const scheduler = makeScheduler();
    let draws = 0;
    const errors: unknown[] = [];
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer(() => {
        draws += 1;
        throw new Error('render failure');
      }),
      onError: (error) => errors.push(error),
      profiler,
      platform: testPlatform({ now: () => 1000, raf: scheduler.raf, caf: scheduler.caf }),
    });

    loop.start().unwrap();
    scheduler.tick(1000);
    scheduler.tick(1000);
    loop.stop().unwrap();

    const capture = finish(profiler);
    expect(draws).toBe(2);
    expect(errors).toHaveLength(2);
    expect(capture.records.filter((record) => record.source === 'app')).toHaveLength(10);
  });
});
