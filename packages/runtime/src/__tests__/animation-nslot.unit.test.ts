// feat-20260713-animation-state-machine-plugin M1 / w1 — variable N-slot lock.
//
// AC-01: AnimationPlayer.clips/times/weights/speeds drop the fixed 4-slot cap
// and become variable `array<T>` columns. This test constructs an entity with
// SIX concurrent slots, runs advanceAnimationPlayer for one frame, and asserts
// the read-back arrays keep length 6 with no overflow / truncation / throw.
//
// TDD red anchor: before the schema migration (w4), `clips` is
// `array<shared<AnimationClip>, 4>`; spawning a 6-element clips array trips the
// ECS `FixedArrayOverflowError` and `.unwrap()` throws — the construction
// itself fails. After w4 the variable schema accepts 6 slots and the frame
// leaves all six weight columns intact.

import { AnimationPlayer, advanceAnimationPlayer } from '@forgeax/engine-animation';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function makeClip(duration: number): AnimationClip {
  return { kind: 'animation-clip', duration, channels: [] };
}

describe('AnimationPlayer — variable N-slot (M1 / w1)', () => {
  it('constructs and evaluates 6 concurrent slots without overflow / truncation', () => {
    const world = new World();
    const clips = Array.from({ length: 6 }, () =>
      world.allocSharedRef('AnimationClip', makeClip(10)),
    );
    const e = world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips,
          times: new Float64Array([0, 0, 0, 0, 0, 0]),
          weights: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
          speeds: new Float32Array([1, 1, 1, 1, 1, 1]),
        },
      })
      .unwrap() as EntityHandle;

    expect(() => advanceAnimationPlayer(world, 0.5)).not.toThrow();

    const ap = world.get(e, AnimationPlayer).unwrap() as unknown as {
      clips: Uint32Array;
      weights: Float32Array;
    };
    // No 4-slot truncation: all six slots survive one frame.
    expect(ap.clips.length).toBe(6);
    expect(ap.weights.length).toBe(6);
    // advance never writes weights back (D-7); the six values read back verbatim.
    expect(Array.from(ap.weights)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
      expect.closeTo(0.4, 5),
      expect.closeTo(0.5, 5),
      expect.closeTo(0.6, 5),
    ]);
    // The 6th clip handle is a real slot, not clamped away.
    expect(ap.clips[5]).toBe(clips[5]);
  });
});
