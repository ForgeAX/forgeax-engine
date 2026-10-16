// feat-20260713-animation-state-machine-plugin M3 / w20 — orthogonal product
// weight (AC-07).
//
// AC-07: a node's effective weight = runtime weight (AnimationPlayer.nodeWeights,
// indexed by node) x graph static weight (the node's declared weight). The two
// factors are orthogonal: changing either one scales the effective weight by the
// product. The canonical check is 0.5 x 0.4 = 0.2.
//
// TDD red anchor: before w24 (nodeWeights field) + w25 the file fails to
// compile; after them the effective weight tracks the product.

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

function readWeight0(world: World, e: EntityHandle): number {
  const weights = (world.get(e, AnimationPlayer).unwrap() as unknown as { weights: Float32Array })
    .weights;
  return weights[0] ?? Number.NaN;
}

describe('evaluateAnimationGraph — orthogonal product weight (M3 / w20)', () => {
  it('effective weight = runtime x static (0.5 x 0.4 = 0.2)', () => {
    const world = new World();
    registerClip(world, 10);

    // Single clip node with STATIC weight 0.4.
    const built = defineAnimationGraph((b) => b.clip('test/animation-clip-h', 0.4));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = world.allocSharedRef('AnimationGraph', built.value);

    // Runtime weight 0.5 on node 0.
    const e = world
      .spawn({
        component: AnimationPlayer,
        data: { graph: graphH, nodeWeights: new Float32Array([0.5]) },
      })
      .unwrap() as EntityHandle;

    evaluateAnimationGraph(world, 0, lookupClip);
    expect(readWeight0(world, e)).toBeCloseTo(0.2, 5); // 0.5 x 0.4

    // Change ONLY the runtime factor to 1.0 -> effective tracks the product 0.4.
    world.set(e, AnimationPlayer, { nodeWeights: new Float32Array([1]) });
    evaluateAnimationGraph(world, 0, lookupClip);
    expect(readWeight0(world, e)).toBeCloseTo(0.4, 5); // 1.0 x 0.4
  });

  it('changing ONLY the static factor scales the effective weight by the product', () => {
    const world = new World();
    registerClip(world, 10);
    registerClip(world, 10);

    // Two graphs differing only in the static weight (0.4 vs 0.8).
    const gA = defineAnimationGraph((b) => b.clip('test/animation-clip-a', 0.4));
    const gB = defineAnimationGraph((b) => b.clip('test/animation-clip-b', 0.8));
    expect(gA.ok && gB.ok).toBe(true);
    if (!gA.ok || !gB.ok) return;
    const hA = world.allocSharedRef('AnimationGraph', gA.value);
    const hB = world.allocSharedRef('AnimationGraph', gB.value);

    // Same runtime factor 0.5 on both.
    const eA = world
      .spawn({
        component: AnimationPlayer,
        data: { graph: hA, nodeWeights: new Float32Array([0.5]) },
      })
      .unwrap() as EntityHandle;
    const eB = world
      .spawn({
        component: AnimationPlayer,
        data: { graph: hB, nodeWeights: new Float32Array([0.5]) },
      })
      .unwrap() as EntityHandle;

    evaluateAnimationGraph(world, 0, lookupClip);
    expect(readWeight0(world, eA)).toBeCloseTo(0.2, 5); // 0.5 x 0.4
    expect(readWeight0(world, eB)).toBeCloseTo(0.4, 5); // 0.5 x 0.8
  });
});
