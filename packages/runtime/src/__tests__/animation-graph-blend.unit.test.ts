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

describe('evaluateAnimationGraph — Blend normalization (M3 / w17)', () => {
  it('Blend(Walk@1, Run@1) yields weights ~= [0.5, 0.5]', () => {
    const world = new World();
    const walk = registerClip(world, 10);
    const run = registerClip(world, 10);

    const built = defineAnimationGraph((b) => {
      const walkNode = b.clip(walk); // static weight default 1
      const runNode = b.clip(run); // static weight default 1
      return b.blend([walkNode, runNode]);
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
    expect(weights[0]).toBeCloseTo(0.5, 5);
    expect(weights[1]).toBeCloseTo(0.5, 5);
    // Blend normalizes: the two leaf effective weights sum to exactly 1.
    expect((weights[0] ?? 0) + (weights[1] ?? 0)).toBeCloseTo(1, 5);
  });
});
