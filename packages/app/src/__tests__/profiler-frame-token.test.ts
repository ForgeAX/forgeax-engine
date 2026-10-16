import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createProfiler, type ProfileCapture } from '@forgeax/engine-profiler';
import type { Renderer, RenderFrameInput } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { APP_PHASE_CATALOG } from '../types';
import { testPlatform } from './platform-fixture';

const FRAME_LOOP_PHASES = [
  'frame-total',
  'draw-source',
  'world-update-primary',
  'world-update-injected',
  'renderer-draw',
] as const;

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

function makeRenderer(onDraw: (profileFrame: unknown) => void = () => {}): Renderer {
  return {
    state: () => 'alive' as const,
    attach: (world: World) => ({ ok: true, value: createRenderReadLease(world) }),
    draw: (request: RenderFrameInput) => {
      onDraw(request.profileFrame);
      return { ok: true, value: undefined };
    },
    subscribe: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

function startSession(
  profiler: ReturnType<typeof createProfiler>,
  frameLimit = 2,
  eventLimit = 64,
) {
  const result = profiler.startCapture({ frameLimit, eventLimit });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function finish(profiler: ReturnType<typeof createProfiler>): ProfileCapture {
  const session = profiler.activeSession();
  if (session === undefined) {
    const latest = profiler.latestCapture();
    expect(latest).toBeDefined();
    if (latest === undefined) throw new Error('capture did not publish');
    return latest;
  }
  const result = session?.finish();
  expect(result?.ok).toBe(true);
  if (result === undefined || !result.ok) throw new Error('capture did not finish');
  return result.value;
}

describe('App profiler frame token', () => {
  it('records the local frame phases with one token per logical frame', () => {
    const profiler = createProfiler();
    expect(startSession(profiler).captureId).toBe('capture-0001');
    const scheduler = makeScheduler();
    const drawOptions: unknown[] = [];
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer((options) => drawOptions.push(options)),
      profiler,
      platform: testPlatform({
        now: (() => {
          const values = [1000, 1016, 1032];
          return () => values.shift() ?? 1032;
        })(),
        raf: scheduler.raf,
        caf: scheduler.caf,
      }),
    });

    loop.start().unwrap();
    scheduler.tick(1016);
    scheduler.tick(1032);
    loop.stop().unwrap();

    const capture = finish(profiler);
    expect(capture.phaseCatalog.app).toEqual(APP_PHASE_CATALOG);
    expect(capture.captureId).toBe('capture-0001');
    expect(capture.records.filter((record) => record.source === 'app')).toHaveLength(10);
    expect(
      capture.records
        .filter((record) => record.source === 'app' && record.kind === 'phase')
        .map((record) => record.phase),
    ).toEqual(expect.arrayContaining([...FRAME_LOOP_PHASES]));
    expect(
      new Set(
        capture.records
          .filter((record) => record.source === 'app' && record.kind === 'phase')
          .map((record) => record.phase),
      ),
    ).toEqual(new Set(FRAME_LOOP_PHASES));
    expect(
      new Set(
        capture.records.filter((record) => record.source === 'app').map((record) => record.frameId),
      ),
    ).toEqual(new Set([1, 2]));
    expect(drawOptions).toHaveLength(2);
    expect(drawOptions[0]).toMatchObject({
      captureId: 'capture-0001',
      frameId: 1,
    });
    expect(drawOptions[1]).toMatchObject({
      captureId: 'capture-0001',
      frameId: 2,
    });
  });

  it('does not reuse capture identity and isolates observer and sink failures', () => {
    const profiler = createProfiler({
      sink: {
        write: () => {
          throw new Error('sink failure');
        },
      },
    });
    const session = startSession(profiler, 1);
    const scheduler = makeScheduler();
    let draws = 0;
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer(() => {
        draws += 1;
      }),
      profiler,
      platform: testPlatform({ now: () => 1000, raf: scheduler.raf, caf: scheduler.caf }),
    });

    loop.start().unwrap();
    scheduler.tick(1000);
    loop.stop().unwrap();
    expect(draws).toBe(1);
    expect(session.finish().ok).toBe(false);

    const secondSession = startSession(profiler, 1);
    expect(secondSession.captureId).not.toBe(session.captureId);
  });

  it('recaptures complete data after an overflow without stale capture state', () => {
    const profiler = createProfiler();
    const scheduler = makeScheduler();
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer(),
      profiler,
      platform: testPlatform({ now: () => 1000, raf: scheduler.raf, caf: scheduler.caf }),
    });

    const overflowSession = startSession(profiler, 1, 1);
    loop.start().unwrap();
    scheduler.tick(1000);

    const overflow = profiler.latestCapture();
    expect(overflow?.captureId).toBe(overflowSession.captureId);
    expect(overflow?.completeness.status).toBe('overflow');
    expect(overflow?.completeness.droppedEventCount).toBeGreaterThan(0);

    const completeSession = startSession(profiler, 1, 64);
    scheduler.tick(1016);
    loop.stop().unwrap();

    const complete = profiler.latestCapture();
    expect(complete?.captureId).toBe(completeSession.captureId);
    expect(complete?.captureId).not.toBe(overflow?.captureId);
    expect(complete?.completeness).toMatchObject({ status: 'complete', droppedEventCount: 0 });
    expect(overflow?.completeness.status).toBe('overflow');
    expect(profiler.activeCaptureId()).toBeUndefined();
  });

  it('publishes a partial artifact when the host stops before its frame boundary', () => {
    const profiler = createProfiler();
    startSession(profiler, 2);
    const scheduler = makeScheduler();
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer(),
      profiler,
      platform: testPlatform({ now: () => 1000, raf: scheduler.raf, caf: scheduler.caf }),
    });

    loop.start().unwrap();
    scheduler.tick(1000);
    loop.stop().unwrap();

    expect(profiler.latestCapture()?.completeness).toMatchObject({
      status: 'partial',
      incompleteReason: 'stopped-before-frame',
    });
    expect(profiler.activeCaptureId()).toBeUndefined();
  });

  it('keeps the default-off path free of profiler records', () => {
    const scheduler = makeScheduler();
    let draws = 0;
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer(() => {
        draws += 1;
      }),
      platform: testPlatform({ now: () => 1000, raf: scheduler.raf, caf: scheduler.caf }),
    });

    loop.start().unwrap();
    scheduler.tick(1000);
    loop.stop().unwrap();

    expect(draws).toBe(1);
  });
});
