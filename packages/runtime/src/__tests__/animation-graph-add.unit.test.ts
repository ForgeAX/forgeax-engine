// feat-20260713-animation-state-machine-plugin M3 / w18 — Add non-normalizing
// (AC-05).
//
// AC-05: Add(base, additive@0.3) stacks the additive layer on top of the base
// WITHOUT normalization. With a base subtree whose effective weight is 1 and an
// additive clip at static weight 0.3, the derived slot weights total 1.3 — the
// hallmark of additive (non-normalizing) blending vs. Blend (which would force
// the total back to 1).
//
// TDD red anchor: before w24 + w25 the file fails to compile; after them the
// Add node leaves the total at 1.3.

import {
  AnimationPlayer,
  defineAnimationGraph,
  evaluateAnimationGraph,
} from '@forgeax/engine-animation';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function registerClip(world: World, duration: number) {
  const clip: AnimationClip = { kind: 'animation-clip', duration, channels: [] };
  return world.allocSharedRef('AnimationClip', clip);
}

const lookupClip = (_guid: string): AnimationClip => ({
  kind: 'animation-clip',
  duration: 10,
  channels: [],
});

function readWeights(world: World, e: EntityHandle): Float32Array {
  return (world.get(e, AnimationPlayer).unwrap() as unknown as { weights: Float32Array }).weights;
}

describe('evaluateAnimationGraph — Add non-normalizing (M3 / w18)', () => {
  it('Add(base@1, additive@0.3) totals 1.3 (additive is NOT normalized)', () => {
    const world = new World();
    registerClip(world, 10);
    registerClip(world, 10);

    const built = defineAnimationGraph((b) => {
      const baseNode = b.clip('test/animation-clip-base'); // static weight 1
      const additiveNode = b.clip('test/animation-clip-additive', 0.3); // static weight 0.3
      return b.add(baseNode, [additiveNode]);
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = world.allocSharedRef('AnimationGraph', built.value);

    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH } })
      .unwrap() as EntityHandle;

    evaluateAnimationGraph(world, 0, lookupClip);

    const weights = readWeights(world, e);
    expect(weights.length).toBe(2);
    // slot 0 = base (unchanged effective weight 1), slot 1 = additive (0.3).
    expect(weights[0]).toBeCloseTo(1, 5);
    expect(weights[1]).toBeCloseTo(0.3, 5);
    const total = (weights[0] ?? 0) + (weights[1] ?? 0);
    expect(total).toBeCloseTo(1.3, 5);
  });
});
