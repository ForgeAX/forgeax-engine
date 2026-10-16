import { testPlatform } from './platform-fixture';
// frame-loop-time-elapsed.test.ts — Time resource `elapsed` accumulator
// (solo bevy-examples round 20260713-212920).
//
// Regression guard for the friction that motivated the field: the Time resource
// was `{ delta }` only, so absolute-time-keyed behavior (pulsing, sin(elapsed))
// forced each system to hand-accumulate delta (drift + re-derivation). The frame-loop
// now writes `{ delta, elapsed }` where elapsed = Σ(clamped delta). These tests pin:
//   1. elapsed accumulates: after N frames of delta, elapsed ≈ N·delta,
//   2. elapsed is monotonic non-decreasing,
//   3. elapsed uses the CLAMPED delta (a huge raw gap advances elapsed by the ceiling,
//      not the raw gap — no time jump),
//   4. delta is still present + correct (existing consumers unaffected).

import { Time, type TimeResource, World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';

function makeSpyRenderer(): Renderer {
  return {
    state: () => 'alive' as const,
    backend: 'webgpu' as const,
    ready: Promise.resolve({ ok: true, value: undefined }),
    attach: () => ({ ok: true, value: undefined }),
    detachWorld: () => {},
    draw(): { ok: true; value: undefined } {
      return { ok: true, value: undefined };
    },
    onError(): () => void {
      return () => {};
    },
    dispose(): void {},
  } as unknown as Renderer;
}

// Scheduler whose `now` advances by a fixed step per tick (deterministic delta).
function makeSyncScheduler(stepMs: number) {
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
    clock += stepMs;
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

function readTime(world: World): TimeResource {
  return world.getResource(Time);
}

describe('Time.elapsed — accumulation', () => {
  it('after N frames of fixed delta, elapsed ≈ N·delta', () => {
    const world = new World();
    // 16 ms/tick → delta = 0.016 s (well under the default clamp ceiling).
    const { raf, caf, now, pump } = makeSyncScheduler(16);
    const loop = createFrameLoop({
      world,
      renderer: makeSpyRenderer(),
      platform: testPlatform({ now, raf, caf }),
    });
    loop.start();
    pump(10);
    const time = readTime(world);
    expect(time.delta).toBeCloseTo(0.016, 6);
    // 10 ticks, but start() sets the baseline at t=16 (first now()), so the first
    // tick's delta is measured from there; elapsed is the running sum of clamped delta.
    // Assert it equals delta * (number of ticks that ran) within a tick's slack.
    expect(time.elapsed).toBeGreaterThan(0.1); // ~10 * 0.016 = 0.16
    expect(time.elapsed).toBeLessThanOrEqual(0.016 * 10 + 1e-9);
    loop.stop();
  });

  it('elapsed is monotonic non-decreasing across frames', () => {
    const world = new World();
    const { raf, caf, now, pump } = makeSyncScheduler(16);
    const loop = createFrameLoop({
      world,
      renderer: makeSpyRenderer(),
      platform: testPlatform({ now, raf, caf }),
    });
    loop.start();
    let prev = -1;
    for (let i = 0; i < 20; i++) {
      pump(1);
      const e = readTime(world).elapsed;
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
    loop.stop();
  });

  it('elapsed uses the CLAMPED delta — a huge raw frame gap does not jump elapsed', () => {
    const world = new World();
    // 5000 ms/tick → raw delta = 5 s, far above the default clamp ceiling. elapsed
    // must advance by the CEILING per tick, not 5 s (no time jump — same clamp the
    // delta field already applies).
    const { raf, caf, now, pump } = makeSyncScheduler(5000);
    const loop = createFrameLoop({
      world,
      renderer: makeSpyRenderer(),
      platform: testPlatform({ now, raf, caf }),
    });
    loop.start();
    pump(3);
    const time = readTime(world);
    // delta is clamped, so a single frame's delta is well under the raw 5 s.
    expect(time.delta).toBeLessThan(1);
    // 3 clamped ticks → elapsed is a few * ceiling, nowhere near the raw 15 s.
    expect(time.elapsed).toBeLessThan(3);
    expect(time.elapsed).toBeCloseTo(time.delta * 3, 6);
    loop.stop();
  });
});
