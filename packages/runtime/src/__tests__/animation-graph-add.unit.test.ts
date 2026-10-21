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

function readWeights(world: World, e: EntityHandle): Float32Array {
  return (world.get(e, AnimationPlayer).unwrap() as unknown as { weights: Float32Array }).weights;
}

describe('evaluateAnimationGraph — Add non-normalizing (M3 / w18)', () => {
  it('Add(base@1, additive@0.3) totals 1.3 (additive is NOT normalized)', () => {
    const world = new World();
    const base = registerClip(world, 10);
    const additive = registerClip(world, 10);

    const built = defineAnimationGraph((b) => {
      const baseNode = b.clip(base); // static weight 1
      const additiveNode = b.clip(additive, 0.3); // static weight 0.3
      return b.add(baseNode, [additiveNode]);
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = testAssets(world).create(built.value).unwrap();

    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH } })
      .unwrap() as EntityHandle;

    evaluateAnimationGraph(world, 0);

    const weights = readWeights(world, e);
    expect(weights.length).toBe(2);
    // slot 0 = base (unchanged effective weight 1), slot 1 = additive (0.3).
    expect(weights[0]).toBeCloseTo(1, 5);
    expect(weights[1]).toBeCloseTo(0.3, 5);
    const total = (weights[0] ?? 0) + (weights[1] ?? 0);
    expect(total).toBeCloseTo(1.3, 5);
  });
});
