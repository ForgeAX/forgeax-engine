// box3.test.ts — box3.fromPositions TDD RED spec (m1-1)
//
// RED phase: box3.fromPositions is not yet implemented (M2).
// All tests assert the numerical semantics that fromPositions must fulfill.
//
// Coverage: multi-point tight enclosure, single point (min==max), empty input
// (inverted-infinity default), degenerate plane (zero-thickness axis),
// out-param return-reference, migration equivalence with geometry
// aabbFromPositions (fixed expected values), non-3-multiple trailing
// behaviour.
//
// Related: requirements AC-06/AC-07; plan-strategy D-1/D-2/D-5;
//          plan-tasks.json m1-1 acceptanceCheck.

import { describe, expect, it } from 'vitest';
import * as box3 from '../box3';

// ============================================================
// Helpers
// ============================================================

/** Assert a Box3 has [minX, minY, minZ, maxX, maxY, maxZ] exactly. */
function expectBox3(
  actual: Float32Array,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  expect(actual[0]).toBe(minX);
  expect(actual[1]).toBe(minY);
  expect(actual[2]).toBe(minZ);
  expect(actual[3]).toBe(maxX);
  expect(actual[4]).toBe(maxY);
  expect(actual[5]).toBe(maxZ);
}

/** Assert min == max on every axis (single-point or degenerate). */
function expectBox3Point(actual: Float32Array, x: number, y: number, z: number): void {
  expectBox3(actual, x, y, z, x, y, z);
}

// ============================================================
// Multi-point tight enclosure
// ============================================================

describe('box3.fromPositions — multi-point', () => {
  it('3 points: min/max across all xyz components', () => {
    const positions = [1, 10, 100, -5, 0, 50, 3, 20, 0];
    // Points: (1,10,100), (-5,0,50), (3,20,0)
    const out = box3.create();
    const result = box3.fromPositions(out, positions);
    expect(result).toBe(out); // out-param returns same reference
    expectBox3(out, -5, 0, 0, 3, 20, 100);
  });

  it('5 points with negative coords: correct min/max envelope', () => {
    const positions = [-1, -2, -3, 4, 5, 6, -7, 8, -9, 0, 0, 0, 10, -10, 1];
    // Points: (-1,-2,-3), (4,5,6), (-7,8,-9), (0,0,0), (10,-10,1)
    const out = box3.create();
    box3.fromPositions(out, positions);
    expectBox3(out, -7, -10, -9, 10, 8, 6);
  });
});

// ============================================================
// Single point (min == max on every axis)
// ============================================================

describe('box3.fromPositions — single point', () => {
  it('one point: min == max on all axes', () => {
    const out = box3.create();
    box3.fromPositions(out, [7, 8, 9]);
    expectBox3Point(out, 7, 8, 9);
  });

  it('origin point', () => {
    const out = box3.create();
    box3.fromPositions(out, [0, 0, 0]);
    expectBox3Point(out, 0, 0, 0);
  });
});

// ============================================================
// Empty / insufficient input → inverted-infinity empty box
// ============================================================

describe('box3.fromPositions — empty input', () => {
  it('0 vertices → inverted-infinity empty box (box3.create() default)', () => {
    const out = box3.create();
    box3.fromPositions(out, []);
    expectBox3(
      out,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    );
  });

  it('1 element (incomplete point) → inverted-infinity empty box', () => {
    const out = box3.create();
    box3.fromPositions(out, [42]);
    expectBox3(
      out,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    );
  });

  it('2 elements (incomplete point) → inverted-infinity empty box', () => {
    const out = box3.create();
    box3.fromPositions(out, [1, 2]);
    expectBox3(
      out,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    );
  });

  it('inverted-empty box is not pickable per pick.ts convention (min > max)', () => {
    const out = box3.create();
    box3.fromPositions(out, []);
    // pick.ts checks: localAabb[0] > localAabb[3] → skip
    // inverted-infinity: +Inf > -Inf → true → correctly skipped
    expect(out[0] as number).toBeGreaterThan(out[3] as number);
  });
});

// ============================================================
// Degenerate plane (one axis zero thickness)
// ============================================================

describe('box3.fromPositions — degenerate plane', () => {
  it('all z=0 → minZ == maxZ == 0 (zero-thickness on Z axis)', () => {
    const positions = [1, 2, 0, 3, 4, 0, 5, 1, 0, 0, 6, 0];
    // Points: (1,2,0), (3,4,0), (5,1,0), (0,6,0)
    const out = box3.create();
    box3.fromPositions(out, positions);
    expectBox3(out, 0, 1, 0, 5, 6, 0);
    expect(out[2]).toBe(out[5]); // minZ == maxZ == 0
  });

  it('all x=0 → minX == maxX == 0 (zero-thickness on X axis)', () => {
    const positions = [0, 1, 2, 0, 3, 4, 0, 5, 6];
    const out = box3.create();
    box3.fromPositions(out, positions);
    expectBox3(out, 0, 1, 2, 0, 5, 6);
    expect(out[0]).toBe(out[3]); // minX == maxX == 0
  });

  it('two points same z → degenerate XY plane strip', () => {
    const positions = [-2, 0, 5, 3, 0, 5];
    const out = box3.create();
    box3.fromPositions(out, positions);
    expectBox3(out, -2, 0, 5, 3, 0, 5);
    expect(out[1]).toBe(out[4]); // minY == maxY == 0
    expect(out[2]).toBe(out[5]); // minZ == maxZ == 5
  });
});

// ============================================================
// Migration equivalence: fixed expected values matching
// geometry aabbFromPositions output for the same inputs
// (no dynamic dependency on geometry package — values are
// hand-computed from the algorithm in box.ts:162-191)
// ============================================================

describe('box3.fromPositions — aabbFromPositions equivalence', () => {
  it('matches aabbFromPositions: 3-point general case', () => {
    // geometry aabbFromPositions would output [1, 1, 0, 4, 8, 6]
    // for positions [1,2,3, 4,1,6, 2,8,0]
    const positions = [1, 2, 3, 4, 1, 6, 2, 8, 0];
    const out = box3.create();
    box3.fromPositions(out, positions);
    expectBox3(out, 1, 1, 0, 4, 8, 6);
  });

  it('matches aabbFromPositions: 6-point all-positive', () => {
    // Positions: (10,20,30), (5,100,5), (1,1,1), (50,25,0), (30,30,30), (0,0,99)
    // min: (0,0,0), max: (50,100,99)
    const positions = [10, 20, 30, 5, 100, 5, 1, 1, 1, 50, 25, 0, 30, 30, 30, 0, 0, 99];
    const out = box3.create();
    box3.fromPositions(out, positions);
    expectBox3(out, 0, 0, 0, 50, 100, 99);
  });

  it('matches aabbFromPositions: negative-and-positive mix', () => {
    // Positions: (-5,-10,-15), (3,7,-2)
    // min: (-5,-10,-15), max: (3,7,-2)
    const positions = [-5, -10, -15, 3, 7, -2];
    const out = box3.create();
    box3.fromPositions(out, positions);
    expectBox3(out, -5, -10, -15, 3, 7, -2);
  });

  it('matches aabbFromPositions: single point case', () => {
    // aabbFromPositions seeds from positions[0..2] and never enters the loop
    const positions = [42, 17, 99];
    const out = box3.create();
    box3.fromPositions(out, positions);
    expectBox3Point(out, 42, 17, 99);
  });

  it('matches aabbFromPositions: empty input → inverted-infinity', () => {
    // aabbFromPositions with Float32Array(0): returns inverted-infinity
    const out = box3.create();
    box3.fromPositions(out, []);
    expectBox3(
      out,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    );
  });
});

// ============================================================
// Non-3-multiple trailing: behaviour matches aabbFromPositions
// (plan-strategy S5.3: trailing elements of an incomplete last point behave identically to old implementation)
// ============================================================

describe('box3.fromPositions — non-3-multiple trailing', () => {
  it('5 elements (last point has 2 values): matches aabbFromPositions', () => {
    // aabbFromPositions: seeds from positions[0..2]=(1,2,3), then i=3:
    // x=4, y=5, z=positions[5]=undefined → NaN; NaN<3 and NaN>3 both false
    // → minZ/maxZ stay at 3 (unchanged from seed).
    const positions = [1, 2, 3, 4, 5];
    const out = box3.create();
    box3.fromPositions(out, positions);
    expectBox3(out, 1, 2, 3, 4, 5, 3);
  });

  it('4 elements (last point has 1 value): matches aabbFromPositions', () => {
    // Seeds from (1,2,3), i=3: x=4, y=positions[4]=undefined,
    // z=positions[5]=undefined → NaN comparisons all false → y,z unchanged.
    const positions = [1, 2, 3, 4];
    const out = box3.create();
    box3.fromPositions(out, positions);
    expectBox3(out, 1, 2, 3, 4, 2, 3);
  });
});

// ============================================================
// Out-param identity
// ============================================================

describe('box3.fromPositions — out-param contract', () => {
  it('returns the same Box3 reference passed as out', () => {
    const out = box3.create();
    const result = box3.fromPositions(out, [1, 2, 3]);
    expect(result).toBe(out);
  });

  it('writes to pre-existing non-default out, overwriting previous state', () => {
    const out = box3.create(100, 100, 100, 200, 200, 200);
    box3.fromPositions(out, [5, 5, 5, -5, -5, -5]);
    expectBox3(out, -5, -5, -5, 5, 5, 5);
  });
});

void expect;
