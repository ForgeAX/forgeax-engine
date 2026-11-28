// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import { branchPCurvePoint, intersectSurfaces } from '../../intersect';
import { intersectFaces } from '../../ssi';
import type { SsiFace, SsiResult } from '../../ssi/types';
import { surfacePoint } from '../../surfaces';
import type { Surface } from '../../types';
import { tube } from './freeform';
import { prng } from './prng';

type P3 = [number, number, number];

/** A bilinear (degree-1) patch over corners c00, c01 (v), c10 (u), c11. */
function bilinear(c00: P3, c01: P3, c10: P3, c11: P3): Surface {
  return {
    kind: 'nurbs',
    surface: {
      degreeU: 1,
      degreeV: 1,
      points: [
        [c00, c01],
        [c10, c11],
      ],
      knotsU: [0, 0, 1, 1],
      knotsV: [0, 0, 1, 1],
    },
  } as Surface;
}

/** Horizontal plate z = 0 over x, y in [-2, 2]. */
const plate: SsiFace = {
  // u runs along y and v along x, so the plate's parameters differ from the wall's (see the orientation test).
  surface: bilinear([-2, -2, 0], [2, -2, 0], [-2, 2, 0], [2, 2, 0]),
};

/** Vertical plate x = 0 over y in [-2, 2], z in [-1, 1]: crosses the plate along the line x = z = 0. */
const wall: SsiFace = {
  surface: bilinear([0, -2, -1], [0, 2, -1], [0, -2, 1], [0, 2, 1]),
};

function must(r: ReturnType<typeof intersectFaces>): SsiResult {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe('NURBS x NURBS: marched intersection of two untrimmed patches', () => {
  it('perpendicular plates cross in one open branch on the line x = z = 0', () => {
    const r = must(intersectFaces(plate, wall));
    expect(r.status).toBe('ok');
    expect(r.issues).toEqual([]);
    expect(r.branches).toHaveLength(1);
    const b = r.branches[0]!;
    expect(b.closed).toBe(false);
    for (const p of b.points) {
      expect(Math.abs(p[0])).toBeLessThanOrEqual(1e-7);
      expect(Math.abs(p[2])).toBeLessThanOrEqual(1e-7);
    }
    // The branch ends where the wall's own top and bottom edges leave the plate's interior.
    const ys = b.points.map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(-2, 5);
    expect(Math.max(...ys)).toBeCloseTo(2, 5);
    expect(b.bound).toBeLessThanOrEqual(1e-7);
  });

  it('disjoint plates give an empty, non-partial result (no seed converges)', () => {
    const above: SsiFace = {
      surface: bilinear([0, -2, 1], [0, 2, 1], [0, -2, 3], [0, 2, 3]),
    };
    const r = must(intersectFaces(plate, above));
    expect(r.branches).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('is symmetric in the operand order: same branch count, pcurves swapped', () => {
    const ab = must(intersectFaces(plate, wall));
    const ba = must(intersectFaces(wall, plate));
    expect(ba.branches.length).toBe(ab.branches.length);
    expect(ba.branches[0]!.points.length).toBe(ab.branches[0]!.points.length);
  });

  it('a NURBS tube cut by a plate: the tube surface is marched in both parameter boxes', () => {
    const t: SsiFace = {
      surface: {
        kind: 'nurbs',
        surface: tube(prng(1), { length: 6, sections: 8, radius: 1, wobble: 0.3 }),
      },
    };
    const r = must(intersectFaces(t, plate));
    expect(r.issues).toEqual([]);
    expect(r.branches.length).toBeGreaterThanOrEqual(2);
    for (const b of r.branches) expect(b.bound).toBeLessThanOrEqual(1e-7);
  });

  it('intersectSurfaces routes NURBS x NURBS to the marched section with pcurves on both faces', () => {
    const a: Surface = plate.surface;
    const b: Surface = wall.surface;
    const r = intersectSurfaces(a, b, 1e-7, { ids: [3, 4] });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.partials).toEqual([]);
    expect(r.value.branches).toHaveLength(1);
    const br = r.value.branches[0]!;
    expect(br.onA.kind).toBe('nurbs');
    expect(br.onB.kind).toBe('nurbs');
    expect(br.receipt).toEqual({ bound: expect.any(Number) });
  });

  it('pcurves land on their own faces in both operand orders: onA maps to A, onB maps to B', () => {
    const a: Surface = plate.surface;
    const b: Surface = wall.surface;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const r = intersectSurfaces(x, y, 1e-7, { ids: [3, 4] });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      expect(r.value.branches.length).toBeGreaterThan(0);
      for (const br of r.value.branches) {
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          const pa = surfacePoint(x, ...(branchPCurvePoint(br.onA, t) as [number, number]));
          const pb = surfacePoint(y, ...(branchPCurvePoint(br.onB, t) as [number, number]));
          const dx = pa[0] - pb[0];
          const dy = pa[1] - pb[1];
          const dz = pa[2] - pb[2];
          expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeLessThanOrEqual(1e-6);
        }
      }
    }
  });
});
