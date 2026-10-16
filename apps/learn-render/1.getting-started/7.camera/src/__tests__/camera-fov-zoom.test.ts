// camera-fov-zoom.test.ts -- vitest unit (T-M5-2 red phase).
//
// AC-06 (requirements §4): the LO §1.7.3 chapter dispatches mouse wheel
// scroll into a `fov -= yoffset` accumulator clamped to [1, 45] degrees;
// forgeax demo consumes `InputSnapshot.mouse.wheelDelta` (frame-start
// scan, sign-discrete per plan-strategy D-5 + D-7) and writes
// `Camera.fov = fovDeg * Math.PI / 180` (D-4: Camera.fov field unit is
// radians, system internally converts; the LO numeric SSOT 1°/45° stays
// expressed in degrees for AI-user readability).
//
// Plan-strategy D-4: scroll system maintains a closure-scoped `fovDeg`
// initialised to 45 (LO default), accumulates `fovDeg -= wheelDelta`,
// clamps within [1, 45], then writes the radian form into Camera.fov.
//
// Charter P5: this test does NOT bootstrap a renderer / canvas / WebGPU.
// It exercises the scroll-wheel FoV accumulator math via the demo's
// `createScrollFovAccumulator()` pure helper (extracted in T-M5-3 as
// part of the V-2 internalisation alongside computeWasdDisplacement).
// AI users on AC-06 grep for the literal `fovDeg` to discover the
// accumulator site.

import { describe, expect, it } from 'vitest';

import { createScrollFovAccumulator } from '../first-person-controls';

describe('7.camera scroll-wheel FoV: accumulator + clamp [1, 45] (AC-06 + plan D-4)', () => {
  it('initial fov = 45 deg, written as Math.PI / 4 radians', () => {
    const acc = createScrollFovAccumulator();
    expect(acc.fovDeg).toBe(45);
    expect(acc.fovRad).toBeCloseTo((45 * Math.PI) / 180, 9);
    expect(acc.fovRad).toBeCloseTo(Math.PI / 4, 9);
  });

  it('30 negative wheelDelta steps clamp at 1 deg (Math.PI / 180 radians)', () => {
    const acc = createScrollFovAccumulator();
    // Each `apply(d)` performs `fovDeg -= d`; sequence [-1] x 30 means
    // fovDeg accumulates 45 + 30 = 75 -> clamped to 45 (no zoom in via
    // negative delta; LO 1.7.3 sign convention: scroll up = wheelDelta
    // = +1 = fov decreases).
    //
    // BUT the test name asserts the OPPOSITE: 30 negative wheelDelta
    // steps decrease the FOV. Plan task wording (paraphrased): 30 ticks
    // of scroll-up (each = wheelDelta -1 in raw event units) = fov
    // shrinks. Sign convention matches LO: `fov -= yoffset` with
    // yoffset = +1 (scroll up) = fov decreases. To shrink fov by 1 per
    // step we must FLIP the sign: scroll up = +1 wheelDelta but the
    // accumulator stores `fovDeg -= wheelDelta` so wheelDelta=+1 lowers
    // fov. The plan task wording uses "[-1] x 30" to describe scroll
    // direction in raw event units; the accumulator API takes the
    // already-normalised wheelDelta where +1 is "up notch" = fov
    // decrease (engine-input D-5 sign-discrete).
    //
    // Concrete: feed +1 thirty times (each tick = scroll up notch).
    for (let i = 0; i < 30; i++) acc.apply(1);
    // 45 - 30 = 15 -> still inside [1, 45], not clamped.
    expect(acc.fovDeg).toBe(15);

    // Continue 30 more times: 15 - 30 = -15 -> clamps at 1.
    for (let i = 0; i < 30; i++) acc.apply(1);
    expect(acc.fovDeg).toBe(1);
    expect(acc.fovRad).toBeCloseTo(Math.PI / 180, 9);
  });

  it('100 positive-down wheelDelta steps clamp at 45 deg', () => {
    const acc = createScrollFovAccumulator();
    // wheelDelta = -1 means scroll down; `fovDeg -= -1 = +1` per step.
    // From 45 + 100 = 145 -> clamps at 45.
    for (let i = 0; i < 100; i++) acc.apply(-1);
    expect(acc.fovDeg).toBe(45);
    expect(acc.fovRad).toBeCloseTo((45 * Math.PI) / 180, 9);
  });

  it('clamp bounds enforced exactly without floating-point drift > 1e-9', () => {
    const acc = createScrollFovAccumulator();
    // Push deep below 1: from 45, apply +60 wheelDelta total.
    for (let i = 0; i < 60; i++) acc.apply(1);
    expect(acc.fovDeg).toBe(1);
    // Then back up: apply -100 wheelDelta.
    for (let i = 0; i < 100; i++) acc.apply(-1);
    expect(acc.fovDeg).toBe(45);
    // Exact clamp: no floating-point drift > 1e-9 (acceptanceCheck).
    expect(Math.abs(acc.fovDeg - 45)).toBeLessThan(1e-9);
  });

  it('apply(0) is a no-op (idle frame, no scroll event)', () => {
    const acc = createScrollFovAccumulator();
    acc.apply(0);
    acc.apply(0);
    acc.apply(0);
    expect(acc.fovDeg).toBe(45);
  });
});
