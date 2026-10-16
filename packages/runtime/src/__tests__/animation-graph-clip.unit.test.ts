// feat-20260713-animation-state-machine-plugin M3 / w16 — Clip node sampling
// (AC-03).
//
// AC-03: a single-Clip graph samples its shared<AnimationClip> at the node's
// seek-time and evaluation outputs ONE slot carrying that clip at full effective
// weight (runtime weight x static weight = 1 x 1 = 1). evaluateAnimationGraph
// fills the AnimationPlayer's derived N-slot columns; the slot fill (clip handle
// + effective weight + resolved time) is the machine-checkable evidence of the
// Clip node semantics (downstream advanceAnimationPlayer does the actual pose
// blend, covered by animation-nslot.unit.test.ts).
//
// TDD red anchor: before w24 (AnimationPlayer.graph field) + w25
// (evaluateAnimationGraph), the imports below do not resolve and the file fails
// to compile. After w24/w25 the single-clip graph fills one slot at weight 1.

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
    registerClip(world, 10);

    const built = defineAnimationGraph((b) => b.clip('test/animation-clip-single'));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = world.allocSharedRef('AnimationGraph', built.value);

    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH } })
      .unwrap() as EntityHandle;

    evaluateAnimationGraph(world, 0, lookupClip);

    const ap = readSlots(world, e);
    // Exactly one clip node -> one derived slot.
    expect(ap.clips.length).toBe(1);
    expect(ap.weights.length).toBe(1);
    expect(ap.times.length).toBe(1);
    expect(ap.speeds.length).toBe(1);
    // The slot carries the clip handle at full effective weight (1 x 1 = 1).
    expect(ap.clips[0]).toBeGreaterThan(0);
    expect(ap.weights[0]).toBeCloseTo(1, 5);
    // Derived path writes speeds[]=0 so advance does not re-advance the time
    // (D-7: eval owns the seek-time, advance must not double-drive it).
    expect(ap.speeds[0]).toBe(0);
  });
});
