import { describe, expect, it } from 'vitest';
import { curvePoint } from '../../../nurbs';
import { branchPCurvePoint, type IntersectionBranch, intersectSurfaces } from '../../intersect';
import { makeFrame, surfacePoint } from '../../surfaces';
import type { Surface } from '../../types';

const f = makeFrame([0, 0, 0], [0, 0, 1]);
const sphere: Surface = { kind: 'sphere', frame: f, radius: 3 };
const torus: Surface = { kind: 'torus', frame: f, major: 3, minor: 0.8 };
const cone: Surface = { kind: 'cone', frame: f, radius: 0.5, halfAngle: 0.4 };
/** Horizontal plate z = 0 over [-5, 5]^2 (bilinear). */
const plate: Surface = {
  kind: 'nurbs',
  surface: {
    degreeU: 1,
    degreeV: 1,
    points: [
      [
        [-5, -5, 0],
        [-5, 5, 0],
      ],
      [
        [5, -5, 0],
        [5, 5, 0],
      ],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  } as Extract<Surface, { kind: 'nurbs' }>['surface'],
};

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** Largest L1 distance of a branch's 3D curve from the two pcurve images, sampled along it. */
function pcurveError(branch: IntersectionBranch, a: Surface, b: Surface): number {
  let worst = 0;
  for (let i = 0; i <= 16; i++) {
    const t = branch.t0 + ((branch.t1 - branch.t0) * i) / 16;
    const p = curvePoint(
      (branch.curve as Extract<typeof branch.curve, { kind: 'nurbs' }>).curve,
      t,
    );
    const pa = branchPCurvePoint(branch.onA, t);
    const pb = branchPCurvePoint(branch.onB, t);
    const sa = surfacePoint(a, pa[0], pa[1]);
    const sb = surfacePoint(b, pb[0], pb[1]);
    for (const q of [sa, sb])
      worst = Math.max(
        worst,
        Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + Math.abs(q[2] - p[2]),
      );
  }
  return worst;
}

describe('NURBS x sphere / torus / cone: marched section through the NURBS route', () => {
  it('sphere: a plate through the centre gives one closed equator of radius 3 on both faces', () => {
    const r = must(intersectSurfaces(plate, sphere, 1e-7, { ids: [1, 2] }));
    expect(r.partials).toEqual([]);
    expect(r.branches).toHaveLength(1);
    const [br] = r.branches;
    if (br === undefined) throw new Error('expected one branch');
    expect(br.closed).toBe(true);
    expect(br.receipt).toEqual({ bound: expect.any(Number) });
    expect((br.receipt as { bound: number }).bound).toBeLessThanOrEqual(1e-7);
    expect(pcurveError(br, plate, sphere)).toBeLessThanOrEqual(1e-6);
  });

  it('torus: the plate through the centre cuts the tube at two circles, radii 3.8 and 2.2', () => {
    const r = must(intersectSurfaces(plate, torus, 1e-7, { ids: [1, 2] }));
    expect(r.partials).toEqual([]);
    expect(r.branches).toHaveLength(2);
    const radii = r.branches.map((br) => {
      const p = curvePoint((br.curve as Extract<typeof br.curve, { kind: 'nurbs' }>).curve, br.t0);
      return Math.sqrt(p[0] * p[0] + p[1] * p[1]);
    });
    expect(Math.min(...radii)).toBeCloseTo(2.2, 4);
    expect(Math.max(...radii)).toBeCloseTo(3.8, 4);
    for (const br of r.branches) expect(pcurveError(br, plate, torus)).toBeLessThanOrEqual(1e-6);
  });

  it('torus: a tilted plate cuts the tube at a generic angle and both tube curves are closed', () => {
    // The plate is tilted so its section avoids the tube's top and bottom, where a narrower
    // tube-angle box would also cover it; the bounds must span the full tube angle to find both loops.
    const tilted: Surface = {
      kind: 'nurbs',
      surface: {
        degreeU: 1,
        degreeV: 1,
        points: [
          [
            [-5, -5, 0.9],
            [-5, 5, 0.9],
          ],
          [
            [5, -5, -0.5],
            [5, 5, -0.5],
          ],
        ],
        knotsU: [0, 0, 1, 1],
        knotsV: [0, 0, 1, 1],
      } as Extract<Surface, { kind: 'nurbs' }>['surface'],
    };
    const r = must(intersectSurfaces(tilted, torus, 1e-7, { ids: [1, 2] }));
    expect(r.partials).toEqual([]);
    expect(r.branches).toHaveLength(2);
    expect(r.branches.every((br) => br.closed)).toBe(true);
    for (const br of r.branches) expect(pcurveError(br, tilted, torus)).toBeLessThanOrEqual(1e-6);
  });

  it('cone: a plate across the cone gives one circle with pcurves on both faces', () => {
    const r = must(intersectSurfaces(plate, cone, 1e-7, { ids: [1, 2] }));
    expect(r.partials).toEqual([]);
    expect(r.branches).toHaveLength(1);
    const [only] = r.branches;
    if (only === undefined) throw new Error('expected one branch');
    expect(pcurveError(only, plate, cone)).toBeLessThanOrEqual(1e-6);
  });

  it('a plate that misses the sphere gives an empty, non-partial result', () => {
    const above: Surface = {
      kind: 'nurbs',
      surface: {
        ...(plate as Extract<Surface, { kind: 'nurbs' }>).surface,
        points: [
          [
            [-5, -5, 5],
            [-5, 5, 5],
          ],
          [
            [5, -5, 5],
            [5, 5, 5],
          ],
        ],
      },
    };
    const r = must(intersectSurfaces(above, sphere, 1e-7, { ids: [1, 2] }));
    expect(r.branches).toEqual([]);
    expect(r.partials).toEqual([]);
  });

  it('operand order: sphere-first gives the same branch count with pcurves on the swapped faces', () => {
    const ab = must(intersectSurfaces(plate, torus, 1e-7, { ids: [1, 2] }));
    const ba = must(intersectSurfaces(torus, plate, 1e-7, { ids: [2, 1] }));
    expect(ba.branches.length).toBe(ab.branches.length);
    for (const br of ba.branches) expect(pcurveError(br, torus, plate)).toBeLessThanOrEqual(1e-6);
  });
});
