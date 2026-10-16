// m2-4 -- player-anim crossfade pure-logic unit test.
//
// The engine has no crossfade() method (research F-03); crossfade is the
// user-space recipe of easing weights[] per frame. blendTowards is the pure
// ease used by player-anim; this test pins the 0.3s settle and clamping so the
// AC-05 "non-hard-cut transition" property is regression-gated.

import { describe, expect, it } from 'vitest';

import { blendTowards, CROSSFADE_DURATION } from '../systems/player-anim';

describe('blendTowards (idle<->locomotion crossfade ease)', () => {
  it('moves toward 1 (locomotion) by dt/duration per step', () => {
    const dt = 0.1;
    const next = blendTowards(0, 1, dt);
    expect(next).toBeCloseTo(dt / CROSSFADE_DURATION, 5);
  });

  it('moves toward 0 (idle) by dt/duration per step', () => {
    const dt = 0.1;
    const next = blendTowards(1, 0, dt);
    expect(next).toBeCloseTo(1 - dt / CROSSFADE_DURATION, 5);
  });

  it('fully settles to 1 after CROSSFADE_DURATION seconds (not a hard cut)', () => {
    let phase = 0;
    const dt = CROSSFADE_DURATION / 3;
    // Three steps of duration/3 reach exactly 1 -- and intermediate values are
    // strictly between 0 and 1 (the AC-05 "blend, not jump" property).
    phase = blendTowards(phase, 1, dt);
    expect(phase).toBeGreaterThan(0);
    expect(phase).toBeLessThan(1);
    phase = blendTowards(phase, 1, dt);
    expect(phase).toBeLessThan(1);
    phase = blendTowards(phase, 1, dt);
    expect(phase).toBeCloseTo(1, 5);
  });

  it('clamps at the [0,1] bounds (no overshoot)', () => {
    expect(blendTowards(1, 1, 0.5)).toBe(1);
    expect(blendTowards(0, 0, 0.5)).toBe(0);
    expect(blendTowards(0.9, 1, 1)).toBe(1);
    expect(blendTowards(0.1, 0, 1)).toBe(0);
  });

  it('holds steady when already at target', () => {
    expect(blendTowards(0.5, 0.5, 0.016)).toBe(0.5);
  });
});
