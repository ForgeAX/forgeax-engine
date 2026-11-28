import { describe, expect, it } from 'vitest';
import { makeFrame } from '../surfaces';
import { MIN_ANGLE, type TrimRing, triangulateTrimmed } from '../tessellate-trimmed';
import type { Surface } from '../types';
import type { P2 } from '../vec';

const plane: Surface = { kind: 'plane', frame: makeFrame([0, 0, 0], [0, 0, 1]) };

function circle(r: number, n: number, ccw: boolean): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((ccw ? i : n - i) / n) * 2 * Math.PI;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}

/** Outer circle radius 1 (CCW) and hole radius 0.3 (CW), sampled at spacing ~0.25. */
function annulusRings(): TrimRing[] {
  const outer = circle(1, 16, true);
  const hole = circle(0.3, 8, false);
  return [
    { uv: outer, ids: outer.map((_, i) => i) },
    { uv: hole, ids: hole.map((_, i) => 100 + i) },
  ];
}

function minAngleOf(
  points: readonly P2[],
  tris: readonly (readonly [number, number, number])[],
): number {
  let min = Math.PI;
  for (const [a, b, c] of tris) {
    const p = [points[a] as P2, points[b] as P2, points[c] as P2];
    for (let k = 0; k < 3; k++) {
      const v = p[k] as P2;
      const u = p[(k + 1) % 3] as P2;
      const w = p[(k + 2) % 3] as P2;
      const ux = u[0] - v[0],
        uy = u[1] - v[1],
        wx = w[0] - v[0],
        wy = w[1] - v[1];
      const cos = (ux * wx + uy * wy) / (Math.hypot(ux, uy) * Math.hypot(wx, wy));
      min = Math.min(min, Math.acos(Math.min(1, Math.max(-1, cos))));
    }
  }
  return min;
}

describe('trimmed refinement minimum angle', () => {
  it('refines the annulus to the minimum-angle bound and leaves boundary samples unchanged', () => {
    const rings = annulusRings();
    const boundary = rings.flatMap((r) => r.uv);
    const r = triangulateTrimmed(plane, rings, {
      angle: 0.6,
      maxPoints: 4000,
      minAngle: MIN_ANGLE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = [...boundary, ...r.value.interior];
    expect(r.value.interior.length).toBeGreaterThan(0);
    // Boundary samples are the first points and are never moved or split.
    for (let i = 0; i < boundary.length; i++) expect(all[i]).toEqual(boundary[i]);
    expect(minAngleOf(all, r.value.triangles)).toBeGreaterThanOrEqual(MIN_ANGLE - 1e-9);
  });

  it('the criterion is the cause: without it the same annulus has a lower minimum angle', () => {
    const rings = annulusRings();
    const boundary = rings.flatMap((r) => r.uv);
    const off = triangulateTrimmed(plane, rings, { angle: 0.6, maxPoints: 4000 });
    const on = triangulateTrimmed(plane, rings, {
      angle: 0.6,
      maxPoints: 4000,
      minAngle: MIN_ANGLE,
    });
    expect(off.ok && on.ok).toBe(true);
    if (!off.ok || !on.ok) return;
    const minOff = minAngleOf([...boundary, ...off.value.interior], off.value.triangles);
    const minOn = minAngleOf([...boundary, ...on.value.interior], on.value.triangles);
    expect(minOn).toBeGreaterThan(minOff);
  });
});
