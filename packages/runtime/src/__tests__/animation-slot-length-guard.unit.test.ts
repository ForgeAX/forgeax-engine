// feat-20260713-animation-state-machine-plugin M1 / w2 — slot-length guard.
//
// AC-11 (parallel-array length-mismatch branch): the four AnimationPlayer SoA
// columns (clips / times / weights / speeds) are variable `array<T>` columns
// set field-by-field (release-then-alloc per field, D-5), so nothing at the ECS
// layer cross-checks their lengths. A single evaluation-entry chokepoint in
// advanceAnimationPlayer must reject a row whose four columns disagree in
// length with a structured error `animation-player-slot-length-mismatch`
// carrying `.code` + `.hint` — never silently zero-pad or truncate.
//
// TDD red anchor: before the schema migration (w4) the columns are fixed
// `array<T, 4>`; a short write is tail-padded to length 4 so the four columns
// are always equal-length and the guard cannot trip — advance never throws and
// this test stays red. After w5 lands the entry guard the mismatch is caught.

import { AnimationPlayer, advanceAnimationPlayer } from '@forgeax/engine-animation';
import { World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function makeClip(duration: number): AnimationClip {
  return { kind: 'animation-clip', duration, channels: [] };
}

interface StructuredError {
  code?: unknown;
  hint?: unknown;
}

describe('AnimationPlayer — slot-length guard (M1 / w2)', () => {
  it('rejects unequal parallel-array lengths with a structured error (no silent pad/truncate)', () => {
    const world = new World();
    const clipOne = world.allocSharedRef('AnimationClip', makeClip(10));
    const clipTwo = world.allocSharedRef('AnimationClip', makeClip(10));

    // clips/times/speeds carry two slots; weights carries only one — a
    // consumer that forgot to keep the four columns length-synced.
    world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [clipOne, clipTwo],
          times: new Float64Array([0, 0]),
          weights: new Float32Array([1]),
          speeds: new Float32Array([1, 1]),
        },
      })
      .unwrap();

    let caught: StructuredError | undefined;
    try {
      advanceAnimationPlayer(world, 0.5);
    } catch (e) {
      caught = e as StructuredError;
    }

    expect(caught).toBeDefined();
    expect(caught?.code).toBe('animation-player-slot-length-mismatch');
    expect(typeof caught?.hint).toBe('string');
    expect((caught?.hint as string).length).toBeGreaterThan(0);
  });

  it('does not throw when the four columns are length-synced', () => {
    const world = new World();
    const clip = world.allocSharedRef('AnimationClip', makeClip(10));

    world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [clip],
          times: new Float64Array([0]),
          weights: new Float32Array([1]),
          speeds: new Float32Array([1]),
        },
      })
      .unwrap();

    expect(() => advanceAnimationPlayer(world, 0.5)).not.toThrow();
  });
});
