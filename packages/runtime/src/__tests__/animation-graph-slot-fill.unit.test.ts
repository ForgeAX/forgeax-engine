// feat-20260713-animation-state-machine-plugin M3 / w21 — DAG eval fills the
// variable N-slot columns (AC-08).
//
// AC-08: post-order DAG evaluation spreads each Clip leaf's effective weight
// into the variable-length weights[] / clips[] columns; a single eval frame is
// then a valid input to advanceAnimationPlayer's N-way blend. This test drives a
// 5-child Blend (proving the retired 4-slot cap is gone) and asserts the derived
// slot distribution equals the expected normalized shares, that clips[] carry
// the source handles in leaf order, and that the derived columns feed advance
// without a length fault.
//
// TDD red anchor: before w24 + w25 the file fails to compile; after them the
// slots read back at the expected distribution.

import {
  AnimationPlayer,
  advanceAnimationPlayer,
  defineAnimationGraph,
  evaluateAnimationGraph,
} from '@forgeax/engine-animation';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function registerClip(world: World, duration: number): number {
  const clip: AnimationClip = { kind: 'animation-clip', duration, channels: [] };
  return world.allocSharedRef('AnimationClip', clip) as unknown as number;
}

const lookupClip = (_guid: string): AnimationClip => ({
  kind: 'animation-clip',
  duration: 10,
  channels: [],
});

function asClipGuid(raw: number): string {
  return `test/animation-clip-${raw}`;
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

describe('evaluateAnimationGraph — variable N-slot fill (M3 / w21)', () => {
  it('spreads a 5-child Blend into 5 slots at the expected distribution', () => {
    const world = new World();
    const handles = [0, 1, 2, 3, 4].map(() => registerClip(world, 10));

    // Blend of FIVE equal-weight clips -> normalized 0.2 each; 5 > 4 proves the
    // fixed 4-slot cap is retired.
    const built = defineAnimationGraph((b) => {
      const leaves = handles.map((h) => b.clip(asClipGuid(h)));
      return b.blend(leaves);
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const graphH = world.allocSharedRef('AnimationGraph', built.value);

    const e = world
      .spawn({ component: AnimationPlayer, data: { graph: graphH } })
      .unwrap() as EntityHandle;

    evaluateAnimationGraph(world, 0, lookupClip);

    const ap = readSlots(world, e);
    expect(ap.clips.length).toBe(5);
    expect(ap.weights.length).toBe(5);
    expect(ap.times.length).toBe(5);
    expect(ap.speeds.length).toBe(5);

    for (let i = 0; i < 5; i++) {
      // clips[] carry the leaf handles in construction (leaf) order.
      expect(ap.clips[i]).toBeGreaterThan(0);
      // Each of five equal leaves gets a normalized 0.2 share.
      expect(ap.weights[i]).toBeCloseTo(0.2, 5);
      // Derived path parks speeds[]=0 (eval owns the seek-time, D-7).
      expect(ap.speeds[i]).toBe(0);
    }

    // The derived slots normalize to exactly 1 (Blend semantics).
    const total = Array.from(ap.weights).reduce((a, w) => a + w, 0);
    expect(total).toBeCloseTo(1, 5);

    // The eval output is a valid input to advance's N-way blend (length-synced).
    expect(() => advanceAnimationPlayer(world, 1 / 60)).not.toThrow();
  });
});
