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

describe('evaluateAnimationGraph — nested DAG post-order (M3 / w19)', () => {
  it('propagates a nested subgraph effective weight down through post-order eval', () => {
    const world = new World();
    const survey = registerClip(world, 10);
    const walk = registerClip(world, 10);
    const run = registerClip(world, 10);
    const overlay = registerClip(world, 10);

    const built = defineAnimationGraph((b) => {
      const surveyNode = b.clip(survey); // node 0
      const walkNode = b.clip(walk); // node 1
      const runNode = b.clip(run); // node 2
      const loco = b.blend([walkNode, runNode]); // node 3
      const base = b.blend([surveyNode, loco]); // node 4
      const overlayNode = b.clip(overlay, 0.5); // node 5
      return b.add(base, [overlayNode]); // node 6 (root)
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = testAssets(world).create(built.value).unwrap();

    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH } })
      .unwrap() as EntityHandle;

    evaluateAnimationGraph(world, 0);

    const weights = readWeights(world, e);
    expect(weights.length).toBe(4); // Survey, Walk, Run, Overlay
    expect(weights[0]).toBeCloseTo(0.5, 5); // Survey
    expect(weights[1]).toBeCloseTo(0.25, 5); // Walk
    expect(weights[2]).toBeCloseTo(0.25, 5); // Run
    expect(weights[3]).toBeCloseTo(0.5, 5); // Overlay (additive)

    // Base subtree (Survey + Walk + Run) normalizes to 1; Overlay adds 0.5.
    const baseSubtree = (weights[0] ?? 0) + (weights[1] ?? 0) + (weights[2] ?? 0);
    expect(baseSubtree).toBeCloseTo(1, 5);
  });
});
