import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createProfiler } from '@forgeax/engine-profiler';
import type { Renderer, RenderFrameInput } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { appSchedulePhaseCatalog } from '../internal/profiled-schedule-runs';
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
  it('retains App phases when a direct renderer opened the capture first', () => {
    const profiler = createProfiler();
    expect(profiler.registerPhaseCatalog('render', ['record']).ok).toBe(true);
    const scheduler = makeScheduler();
    const frames: unknown[] = [];
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer((frame) => frames.push(frame)),
      profiler,
      platform: testPlatform({ now: () => 1000, raf: scheduler.raf, caf: scheduler.caf }),
    });
    const session = start(profiler);
    expect(session.beginFrame(1).ok).toBe(true);
    expect(session.beginPhase('render', 'record').ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(session.endFrame().ok).toBe(true);

    loop.start().unwrap();
    scheduler.tick(1000);
    loop.stop().unwrap();

    const capture = finish(profiler);
    expect(frames[0]).toEqual({ captureId: capture.captureId, frameId: 2 });
    const app = capture.records.filter((record) => record.source === 'app');
    expect(app).toHaveLength(4);
    expect(app.every((record) => record.frameId === 2)).toBe(true);
    expect(capture.completeness.status).toBe('complete');
  });

  it('keeps normal and App-only frames on one capture identity', () => {
    const profiler = createProfiler();
    const scheduler = makeScheduler();
    const drawOptions: unknown[] = [];
    const world = new World();
    const loop = createFrameLoop({
      world,
      renderer: makeRenderer((options) => drawOptions.push(options)),
      profiler,
      platform: testPlatform({ now: () => 1000, raf: scheduler.raf, caf: scheduler.caf }),
    });

    start(profiler);
    loop.start().unwrap();
    scheduler.tick(1000);
    loop.stop().unwrap();

    const capture = finish(profiler);
    expect(capture.records.filter((record) => record.source === 'app')).toHaveLength(4);
    expect(capture.records.every((record) => record.frameId === 1)).toBe(true);
    expect(drawOptions[0]).toMatchObject({
      captureId: capture.captureId,
      frameId: 1,
    });
    expect(new Set(capture.phaseCatalog.app)).toEqual(
      new Set([...APP_PHASE_CATALOG, ...appSchedulePhaseCatalog([world])]),
    );
    expect(profiler.phaseCatalog.app).toEqual([]);
  });

  it('isolates a renderer failure while the host frame loop continues', () => {
    const profiler = createProfiler();
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

    start(profiler);
    loop.start().unwrap();
    scheduler.tick(1000);
    scheduler.tick(1000);
    loop.stop().unwrap();

    const capture = finish(profiler);
    expect(draws).toBe(2);
    expect(errors).toHaveLength(2);
    expect(capture.records.filter((record) => record.source === 'app')).toHaveLength(8);
  });
});
