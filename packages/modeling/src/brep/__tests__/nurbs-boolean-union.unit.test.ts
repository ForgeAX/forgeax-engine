import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box } from '../build';
import { measure } from '../measure';
import { sweep } from '../sweep';
import { transformShape } from '../transform';

const sq = (h: number) =>
  [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ] as const;
const frame = {
  o: [0, 0, 0] as [number, number, number],
  x: [1, 0, 0] as [number, number, number],
  y: [0, 1, 0] as [number, number, number],
  z: [0, 0, 1] as [number, number, number],
};
const identity = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

// Quarter torus segment: centreline radius 4, square section of half-width 0.25 (volume pi/2).
function stub() {
  return must(
    sweep({
      profile: sq(0.25),
      path: { kind: 'circle', frame, radius: 4 },
      xHint: [0, 0, 1],
      stations: 17,
      range: [0, Math.PI / 2],
    }),
  );
}

// Plate x 3.5..4.5, y 0.2..0.5, z -0.1..0.1. Its faces never cross the stub's y=0 or x=0 caps (planes
// crossing planes are unsupported on trunk), so every crossing is plate face against a NURBS side.
function plate() {
  return must(
    transformShape(must(box({ size: [1, 0.3, 0.2] })), {
      rot: identity as never,
      t: [4, 0.35, 0],
    }),
  );
}

// Analytic union. Overlap = 0.2 * A, A = area of {3.5<=x<=4.5, 0.2<=y<=0.5, 3.75<=r<=4.25}
// = integral over y in [0.2,0.5] of (sqrt(4.25^2 - y^2) - sqrt(3.75^2 - y^2)), in closed form.
const antiderivative = (r2: number, y: number) =>
  (y / 2) * Math.sqrt(r2 - y * y) + (r2 / 2) * Math.asin(y / Math.sqrt(r2));
const overlapArea =
  antiderivative(4.25 ** 2, 0.5) -
  antiderivative(3.75 ** 2, 0.5) -
  (antiderivative(4.25 ** 2, 0.2) - antiderivative(3.75 ** 2, 0.2));
const PLATE_VOLUME = 1 * 0.3 * 0.2;
const ANALYTIC_UNION = Math.PI / 2 + PLATE_VOLUME - 0.2 * overlapArea;

describe('union of a NURBS sweep stub with a placed planar plate', () => {
  it('matches the analytic union volume within 1e-3', () => {
    const u = must(booleanSolids(stub(), plate(), 'union'));
    const v = must(measure(u)).volume;
    expect(Math.abs(v - ANALYTIC_UNION)).toBeLessThan(1e-3);
  });
});
