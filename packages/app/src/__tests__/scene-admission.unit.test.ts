import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import type { Renderer, RenderFrameInput } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { testPlatform } from './platform-fixture';

interface DrawCall {
  readonly request: RenderFrameInput;
}

function makeSpyRenderer(): { renderer: Renderer; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const renderer = {
    state: () => 'alive' as const,
    attach: (world: World) => ({ ok: true, value: createRenderReadLease(world) }),
    draw(request: RenderFrameInput): { ok: true; value: undefined } {
      calls.push({ request });
      return { ok: true, value: undefined };
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
 * Mirrors frame-loop-world-array.test.ts so both single-world contract tests
 * step the loop identically.
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

describe('scene admission', () => {
  it.each([
    false,
    true,
  ])('draws only its source with an explicit admission getter: %s', (explicit) => {
    const world = new World();
    const { renderer, calls } = makeSpyRenderer();
    const clock = makeSyncScheduler();
    const admission = vi.fn(() => 'scene' as const);
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform(clock),
      ...(explicit ? { sceneAdmission: admission } : {}),
    });
    loop.start().unwrap();
    clock.pump(3);
    expect(calls).toHaveLength(3);
    expect(admission).toHaveBeenCalledTimes(explicit ? 3 : 0);
    for (const { request } of calls) {
      expect(request.source?.worldIdentity).toBe(world.identity);
    }
    loop.stop().unwrap();
  });

  it('keeps updating and retains its source lease across UI-only frames', () => {
    const world = new World();
    const update = vi.spyOn(world, 'update');
    const { renderer, calls } = makeSpyRenderer();
    const attach = vi.spyOn(renderer, 'attach');
    const clock = makeSyncScheduler();
    let admission: 'scene' | 'ui-only' = 'ui-only';
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform(clock),
      sceneAdmission: () => admission,
    });
    loop.start().unwrap();
    clock.pump(2);
    admission = 'scene';
    clock.pump(1);
    admission = 'ui-only';
    clock.pump(1);
    expect(update).toHaveBeenCalledTimes(4);
    expect(attach).toHaveBeenCalledTimes(1);
    for (const index of [0, 1, 3]) expect(calls[index]?.request).toMatchObject({ source: null });
    expect(calls[2]?.request.source?.worldIdentity).toBe(world.identity);
    loop.stop().unwrap();
  });

  it('reports an invalid getter without drawing, then admits the following source update once', () => {
    const world = new World();
    const update = vi.spyOn(world, 'update');
    const { renderer, calls } = makeSpyRenderer();
    const clock = makeSyncScheduler();
    const onError = vi.fn();
    let admission = 'invalid';
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform(clock),
      onError,
      sceneAdmission: () => admission as never,
    });
    loop.start().unwrap();
    clock.pump(1);
    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    admission = 'scene';
    clock.pump(1);
    expect(update).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    loop.stop().unwrap();
  });
});
