import { Time, Update, World } from '@forgeax/engine-ecs';
import type { Renderer, RendererState, RenderWorldLease } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { testPlatform } from './platform-fixture';

function lease(): RenderWorldLease {
  return {
    worldIdentity: {},
    generation: 0,
    readChanges: vi.fn(),
    querySpans: vi.fn(),
    inspectCursor: vi.fn(),
    dispose: vi.fn(),
  } as unknown as RenderWorldLease;
}

function scheduler() {
  let pending: ((timestamp: number) => void) | undefined;
  return {
    raf: (callback: (timestamp: number) => void): number => {
      pending = callback;
      return 1;
    },
    caf: (): void => {
      pending = undefined;
    },
    tick(timestamp: number): void {
      const callback = pending;
      pending = undefined;
      callback?.(timestamp);
    },
  };
}

function renderer(states: readonly RendererState[]) {
  let index = 0;
  let draws = 0;
  const value = {
    backend: 'webgpu' as const,
    state: () => states[Math.min(index++, states.length - 1)] ?? 'alive',
    attach: () => ({ ok: true, value: lease() }),
    draw: () => {
      draws += 1;
      return { ok: true, value: { frameId: draws, deviceGeneration: 0, completed: true as const } };
    },
    onError: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
  return {
    value,
    get draws() {
      return draws;
    },
  };
}

describe('M4 / m4_t1 — App frame admission fences device loss', () => {
  it('keeps rAF alive but freezes primary and injected Worlds during loss', () => {
    const primary = new World();
    const injected = new World();
    primary.addSystem(Update, { name: 'primary-update', queries: [], fn: () => {} }).unwrap();
    injected.addSystem(Update, { name: 'injected-update', queries: [], fn: () => {} }).unwrap();
    const events: string[] = [];
    primary
      .addSystem(Update, { name: 'observe-primary', queries: [], fn: () => events.push('primary') })
      .unwrap();
    injected
      .addSystem(Update, {
        name: 'observe-injected',
        queries: [],
        fn: () => events.push('injected'),
      })
      .unwrap();
    const clock = scheduler();
    let measured = 1000;
    const rendererState = renderer(['device-lost', 'device-lost', 'alive', 'alive']);
    const loop = createFrameLoop({
      world: primary,
      renderer: rendererState.value,
      drawSource: () => ({ worlds: [primary, injected], cameraOwner: 0, resourceOwner: 0 }),
      platform: testPlatform({ now: () => measured, raf: clock.raf, caf: clock.caf }),
    });

    loop.start().unwrap();
    measured = 1016;
    clock.tick(measured);
    measured = 1020;
    clock.tick(measured);

    expect(events).toEqual([]);
    expect(primary.getResource(Time).delta).toBe(0);
    expect(injected.getResource(Time).delta).toBe(0);
    expect(rendererState.draws).toBe(0);

    measured = 1024;
    clock.tick(measured);
    expect(events).toEqual(['primary', 'injected']);
    expect(primary.getResource(Time).delta).toBeCloseTo(0.004);
    expect(injected.getResource(Time).delta).toBeCloseTo(0.004);
    expect(rendererState.draws).toBe(1);
    loop.stop().unwrap();
  });

  it('does not update or issue a receipt from stepFrame while recovering', () => {
    const world = new World();
    let updates = 0;
    world
      .addSystem(Update, {
        name: 'count-update',
        queries: [],
        fn: () => {
          updates += 1;
        },
      })
      .unwrap();
    const rendererState = renderer(['device-lost']);
    const loop = createFrameLoop({
      world,
      renderer: rendererState.value,
      platform: testPlatform({}),
    });
    loop.start().unwrap();
    loop.pause().unwrap();

    const stepped = loop.stepFrame(1 / 60);

    expect(stepped.ok).toBe(true);
    expect(updates).toBe(0);
    expect(rendererState.draws).toBe(0);
    loop.stop().unwrap();
  });
});
