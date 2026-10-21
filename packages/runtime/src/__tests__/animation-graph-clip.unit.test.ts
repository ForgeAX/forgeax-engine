import {
  AnimationPlayer,
  defineAnimationGraph,
  evaluateAnimationGraph,
} from '@forgeax/engine-animation';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { testAssets } from './helpers/runtime-assets';

function registerClip(world: World, duration: number) {
  const clip: AnimationClip = { kind: 'animation-clip', duration, channels: [] };
  return testAssets(world).create(clip).unwrap();
}

interface Slots {
  clips: Uint32Array;
  times: Float64Array;
  weights: Float32Array;
  speeds: Float32Array;
}

function readSlots(world: World, e: EntityHandle): Slots {
  return world.get(e, AnimationPlayer).unwrap() as unknown as Slots;
}

describe('evaluateAnimationGraph — Clip node sampling (M3 / w16)', () => {
  it('fills one slot at full effective weight for a single-Clip graph', () => {
    const world = new World();
    const clip = registerClip(world, 10);

    const built = defineAnimationGraph((b) => b.clip(clip));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = testAssets(world).create(built.value).unwrap();

    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH } })
      .unwrap() as EntityHandle;

    evaluateAnimationGraph(world, 0);

    const ap = readSlots(world, e);
    // Exactly one clip node -> one derived slot.
    expect(ap.clips.length).toBe(1);
    expect(ap.weights.length).toBe(1);
    expect(ap.times.length).toBe(1);
    expect(ap.speeds.length).toBe(1);
    // The slot carries the clip handle at full effective weight (1 x 1 = 1).
    expect(ap.clips[0]).toBe(clip);
    expect(ap.weights[0]).toBeCloseTo(1, 5);
    // Derived path writes speeds[]=0 so advance does not re-advance the time
    // (D-7: eval owns the seek-time, advance must not double-drive it).
    expect(ap.speeds[0]).toBe(0);
  });
});
