import { testPlatform } from './platform-fixture';
// feat-20260709-editor-world-partition-editorworld-super-composite / M2 / w9
// (RED — impl lands in w12). Contract test: a world injected through drawSource
// MUST be world.update(1 / 60).unwrap()'d by the frame-loop in the SAME frame it is drawn, so
// the renderer reads a freshly-propagated GlobalTransform.world mat4 — never a stale
// one.
//
// Why this matters (Strategist D-3, not covered by research): the renderer's
// extract stage reads the DERIVED `GlobalTransform.world` column, whose sole writer is
// the propagateTransforms system (plugin-factories.ts / systems/propagate-
// transforms.ts). That writer only runs inside `world.update(1 / 60).unwrap()`. If drawSource
// merely fed injected worlds into `renderer.draw(worlds, ...)` WITHOUT the
// frame-loop running `world.update(1 / 60).unwrap()` on them first, the renderer would read the
// injected world's GlobalTransform.world at its previous (or default identity) value —
// a stale-matrix bug that renders the injected world one frame behind (or at the
// origin on the first frame).
//
// This test spawns an entity in the injected world with a DISTINGUISHING
// non-identity translation and never calls world.update(1 / 60).unwrap() on that world itself.
// The spy renderer reads `GlobalTransform.world` at draw time. A frame-loop that
// updates injected worlds surfaces the translation in the mat4's column-major
// [12]/[13]/[14] slots; a draw-only frame-loop surfaces the identity default
// (0/0/0), which fails the assertion. So the test has genuine discriminating
// power over the stale-matrix regression.
//
// Driven through createFrameLoop directly with injected now / raf / caf seams,
// mirroring frame-loop-world-array.test.ts. The drawSource option is reached
// through a typed alias before w12 widens the real FrameLoopOptions type.
//
// Anchors:
//   plan-strategy §2 D-3 (frame-loop MUST update injected worlds — transform
//     propagation — before draw; not draw-only)
//   research F1 (frame-loop is the world.update -> renderer.draw driver)
//   AGENTS.md invariant 6 (GlobalTransform.world is the derived fidelity seam)

import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import type { Renderer } from '@forgeax/engine-render';
import { GlobalTransform, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { createFrameLoop, type FrameLoopOptions } from '../internal/frame-loop';

// Distinguishing translation for the injected world's entity. Column-major mat4
// carries translation at indices [12] (x), [13] (y), [14] (z).
const INJECTED_TX = 5;
const INJECTED_TY = -3;
const INJECTED_TZ = 7;

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

type DrawSourceCallback = () =>
  | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
  | undefined;

type FrameLoopOptionsWithDrawSource = FrameLoopOptions & {
  drawSource?: DrawSourceCallback;
};

const createFrameLoopWithDrawSource = createFrameLoop as unknown as (
  opts: FrameLoopOptionsWithDrawSource,
) => ReturnType<typeof createFrameLoop>;

describe('drawSource injected worlds are updated same-frame (w9, stale-matrix regression)', () => {
  it('renderer reads a freshly-propagated GlobalTransform.world for the injected world at draw time', () => {
    // The loop's OWN world — the single-world identity path. Never carries the
    // injected entity, so it cannot mask a stale read on the injected world.
    const loopWorld = new World();

    // The injected world: register propagateTransforms (the sole GlobalTransform.world
    // writer) and spawn an entity with a distinguishing non-identity translation.
    // We deliberately do NOT call injectedWorld.update() here — the frame-loop
    // must run it for the translation to reach GlobalTransform.world.
    const injectedWorld = new World();
    registerPropagateTransforms(injectedWorld);
    const spawned = injectedWorld
      .spawn({
        component: Transform,
        data: {
          pos: [INJECTED_TX, INJECTED_TY, INJECTED_TZ],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      })
      .unwrap();
    const entity = spawned as unknown as EntityHandle;

    // Sanity: BEFORE any frame, GlobalTransform.world is still the identity default
    // (translation columns are 0). This proves the assertion below measures the
    // frame-loop's update, not a pre-propagated value.
    const before = injectedWorld.get(entity, GlobalTransform);
    expect(before.ok).toBe(true);
    if (before.ok) {
      const w = before.value.world as unknown as ArrayLike<number>;
      expect(w[12]).toBe(0);
      expect(w[13]).toBe(0);
      expect(w[14]).toBe(0);
    }

    // Spy renderer: at draw time, read the injected world's GlobalTransform.world and
    // record the translation columns. This is the exact read the real extract
    // stage performs (GlobalTransform.world is the extract SSOT).
    const observed: Array<[number, number, number]> = [];
    const renderer = {
      state: () => 'alive' as const,
      attach: (world: World) => ({ ok: true, value: createRenderReadLease(world) }),
      draw(): { ok: true; value: undefined } {
        const r = injectedWorld.get(entity, GlobalTransform);
        if (r.ok) {
          const m = r.value.world as unknown as ArrayLike<number>;
          observed.push([m[12] as number, m[13] as number, m[14] as number]);
        }
        return { ok: true, value: undefined };
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

    const drawSource: DrawSourceCallback = () => ({
      worlds: [injectedWorld],
      cameraOwner: 0,
      resourceOwner: 0,
    });

    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoopWithDrawSource({
      world: loopWorld,
      renderer,
      platform: testPlatform({ now, raf, caf }),
      drawSource,
    });

    expect(loop.start().ok).toBe(true);
    pump(2);
    loop.stop();

    // At least one frame observed the injected world, and every observation saw
    // the FRESH translation — the frame-loop ran injectedWorld.update() before
    // draw. A draw-only frame-loop would observe [0, 0, 0] (identity) and fail.
    expect(observed.length).toBeGreaterThanOrEqual(1);
    for (const [x, y, z] of observed) {
      expect(x).toBeCloseTo(INJECTED_TX);
      expect(y).toBeCloseTo(INJECTED_TY);
      expect(z).toBeCloseTo(INJECTED_TZ);
    }
  });
});
