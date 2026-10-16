import { testPlatform } from './platform-fixture';
// feat-20260709-editor-world-partition-editorworld-super-composite / M2 / w8
// (RED — impl lands in w12). Contract test: the drawSource injection seam MUST
// degrade to the existing single-world path byte-identically when the host does
// not opt in.
//
// Two non-opt-in shapes must both reproduce the legacy call
// `renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })` (feat-20260708 M3 / AC-03 wrapping):
//
//   1. `drawSource` absent entirely — the createApp/frame-loop caller passes no
//      drawSource (the single-world AI-user default).
//   2. `drawSource` present but returning `undefined` on the frame — a host
//      that wired the seam but, this frame, has nothing multi-world to inject
//      (e.g. editor with no partitioned viewport active).
//
// Both cases MUST call `renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })` with the loop's
// own single world and owner 0. This pins the AC-03 regression guarantee across
// the new seam: adding drawSource never perturbs the single-world path.
//
// This test drives createFrameLoop directly (injected now / raf / caf seams)
// with a spy renderer, mirroring frame-loop-world-array.test.ts. The drawSource
// option is reached through a typed alias so the intent reads clearly before w12
// widens the real FrameLoopOptions type (test-first RED window).
//
// Anchors:
//   plan-strategy §2 D-3 (drawSource pull callback; absent / undefined -> single
//     world path byte-identical to draw([world], { cameraOwner: 0, resourceOwner: 0 }))
//   research F1 (frame-loop hardcodes renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }) — the
//     seam insertion point)

import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import type { Renderer, RenderFrameInput } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import { createFrameLoop, type FrameLoopOptions } from '../internal/frame-loop';

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

// The drawSource pull callback shape w11/w12 will introduce on FrameLoopOptions.
// Declared locally so this test states the contract independent of the (not-yet
// widened) source type. `undefined` return = "no multi-world injection this
// frame" (degrade to single world).
type DrawSourceCallback = () =>
  | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
  | undefined;

type FrameLoopOptionsWithDrawSource = FrameLoopOptions & {
  drawSource?: DrawSourceCallback;
};

const createFrameLoopWithDrawSource = createFrameLoop as unknown as (
  opts: FrameLoopOptionsWithDrawSource,
) => ReturnType<typeof createFrameLoop>;

describe('drawSource seam degrades to single-world path (w8, AC-03 regression)', () => {
  it('no drawSource: draws the primary World with explicit camera and resource owners', () => {
    const world = new World();
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now, pump } = makeSyncScheduler();

    // No drawSource field at all — the single-world AI-user default.
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
    });
    expect(loop.start().ok).toBe(true);
    pump(3);

    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.request.leases).toHaveLength(1);
      expect(call.request.leases[0]?.worldIdentity).toBe(world.identity);
      expect(call.request.camera?.lease).toBe(call.request.leases[0]);
      expect(call.request.environment?.lease).toBe(call.request.leases[0]);
    }

    loop.stop();
  });

  it('drawSource returns undefined: still draws [world] with { cameraOwner: 0, resourceOwner: 0 } (no-inject frame)', () => {
    const world = new World();
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now, pump } = makeSyncScheduler();

    let pulls = 0;
    const drawSource: DrawSourceCallback = () => {
      pulls++;
      // Host wired the seam but has nothing multi-world to inject this frame.
      return undefined;
    };

    const loop = createFrameLoopWithDrawSource({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
      drawSource,
    });
    expect(loop.start().ok).toBe(true);
    pump(3);

    // The seam was consulted (pull callback fired) but the resulting draw is
    // identical to the primary-World call.
    expect(pulls).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.request.leases).toHaveLength(1);
      expect(call.request.leases[0]?.worldIdentity).toBe(world.identity);
      expect(call.request.camera?.lease).toBe(call.request.leases[0]);
      expect(call.request.environment?.lease).toBe(call.request.leases[0]);
    }

    loop.stop();
  });

  it('setDrawSource switches routing without creating a second frame loop', () => {
    const world = new World();
    const overlay = new World();
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
    });

    expect(loop.start().ok).toBe(true);
    pump(1);
    loop.setDrawSource(() => ({ worlds: [world, overlay], cameraOwner: 0, resourceOwner: 0 }));
    pump(1);
    loop.setDrawSource(undefined);
    pump(1);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.request.leases).toHaveLength(1);
    expect(calls[0]?.request.leases[0]?.worldIdentity).toBe(world.identity);
    expect(calls[1]?.request.leases).toHaveLength(2);
    expect(calls[1]?.request.leases[0]?.worldIdentity).toBe(world.identity);
    expect(calls[1]?.request.leases[1]?.worldIdentity).toBe(overlay.identity);
    expect(calls[1]?.request.camera?.lease).toBe(calls[1]?.request.leases[0]);
    expect(calls[1]?.request.environment?.lease).toBe(calls[1]?.request.leases[0]);
    expect(calls[2]?.request.leases).toHaveLength(1);
    expect(calls[2]?.request.leases[0]?.worldIdentity).toBe(world.identity);
    loop.stop();
  });

  it('keeps the same loop and World updates across scene admission and retirement', () => {
    const world = new World();
    const update = vi.spyOn(world, 'update');
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now, pump } = makeSyncScheduler();
    const failures: unknown[] = [];
    const loop = createFrameLoop({
      world,
      renderer,
      platform: testPlatform({ now, raf, caf }),
      drawSource: () => null,
      onError: (error) => failures.push(error),
    });
    expect(loop.start().ok).toBe(true);
    expect(loop.pause().ok).toBe(true);
    expect(loop.resume().ok).toBe(true);
    pump(2);
    loop.setDrawSource(undefined);
    pump(1);
    loop.setDrawSource(() => null);
    pump(1);
    expect(calls).toHaveLength(4);
    expect(update).toHaveBeenCalledTimes(4);
    for (const index of [0, 1, 3]) {
      expect(calls[index]?.request).toMatchObject({ leases: [], camera: null, environment: null });
    }
    expect(calls[2]?.request.camera?.lease.worldIdentity).toBe(world.identity);
    expect(calls[2]?.request.temporalReset).toBe(true);
    expect(loop.getState()).toBe('running');
    expect(failures).toEqual([]);
    loop.stop();
  });
});
