// feat-20260713-animation-state-machine-plugin M3 / w17 — Blend normalization
// (AC-04).
//
// AC-04: Blend(Walk@1, Run@1) evaluates its children with NORMALIZED effective
// weights so they sum to 1 — the two equal-weight leaves each land at 0.5. The
// derived N-slot columns are filled leaf-node-first (construction order), so
// slot 0 = Walk, slot 1 = Run, both at ~0.5.
//
// TDD red anchor: before w24 (AnimationPlayer.graph field) + w25
// (evaluateAnimationGraph) the file fails to compile; after them the blend
// normalizes to [0.5, 0.5].

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

describe('evaluateAnimationGraph — Blend normalization (M3 / w17)', () => {
  it('Blend(Walk@1, Run@1) yields weights ~= [0.5, 0.5]', () => {
    const world = new World();
    registerClip(world, 10);
    registerClip(world, 10);

    const built = defineAnimationGraph((b) => {
      const walkNode = b.clip('test/animation-clip-walk'); // static weight default 1
      const runNode = b.clip('test/animation-clip-run'); // static weight default 1
      return b.blend([walkNode, runNode]);
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
    expect(weights[0]).toBeCloseTo(0.5, 5);
    expect(weights[1]).toBeCloseTo(0.5, 5);
    // Blend normalizes: the two leaf effective weights sum to exactly 1.
    expect((weights[0] ?? 0) + (weights[1] ?? 0)).toBeCloseTo(1, 5);
  });
});
