// feat-20260713-animation-state-machine-plugin M3 / w19 — nested DAG post-order
// evaluation (AC-06).
//
// AC-06: a multi-layer DAG evaluates post-order so a nested subgraph's
// normalized effective weight is correctly propagated down before its parent
// combines it. This mirrors the AC-13 fox demo topology:
//
//   Add( Base=Blend(Survey, Loco=Blend(Walk, Run)), Overlay@0.5 )
//
// With all static/runtime weights 1 (Overlay static 0.5):
//   - Loco normalizes Walk/Run to 0.5 each, then scales by the 0.5 it receives
//     from Base's normalization -> Walk=0.25, Run=0.25.
//   - Base normalizes Survey vs Loco to 0.5 each -> Survey=0.5, Loco subtree=0.5.
//   - Overlay is additive on top at its static 0.5.
// Derived slots (clip-node order): [Survey, Walk, Run, Overlay]
//   = [0.5, 0.25, 0.25, 0.5]; base subtree sums to 1, total is 1.5.
//
// TDD red anchor: before w24 + w25 the file fails to compile; after them the
// nested weights propagate as above.

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

describe('evaluateAnimationGraph — nested DAG post-order (M3 / w19)', () => {
  it('propagates a nested subgraph effective weight down through post-order eval', () => {
    const world = new World();
    registerClip(world, 10);
    registerClip(world, 10);
    registerClip(world, 10);
    registerClip(world, 10);

    const built = defineAnimationGraph((b) => {
      const surveyNode = b.clip('test/animation-clip-survey'); // node 0
      const walkNode = b.clip('test/animation-clip-walk'); // node 1
      const runNode = b.clip('test/animation-clip-run'); // node 2
      const loco = b.blend([walkNode, runNode]); // node 3
      const base = b.blend([surveyNode, loco]); // node 4
      const overlayNode = b.clip('test/animation-clip-overlay', 0.5); // node 5
      return b.add(base, [overlayNode]); // node 6 (root)
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = world.allocSharedRef('AnimationGraph', built.value);

    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH } })
      .unwrap() as EntityHandle;

    evaluateAnimationGraph(world, 0, lookupClip);

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
