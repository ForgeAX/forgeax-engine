import { cos, sin } from '../../dmath';
import type { EditMesh } from '../../mesh';
import { domain as curveDomain, curvePoint } from '../../nurbs';
import { surfaceDomain, surfacePoint } from '../surfaces';
import type { Placement } from '../transform';
import type { Shape } from '../types';
import type { P3 } from '../vec';

export function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** A proper rotation of `angle` about the skew axis (1, 2, 3), then a translation: a general placement. */
export function skewPlacement(angle: number): Placement {
  const n = Math.sqrt(14);
  const x = 1 / n;
  const y = 2 / n;
  const z = 3 / n;
  const c = cos(angle);
  const s = sin(angle);
  const k = 1 - c;
  return {
    rot: [
      [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
      [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
      [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
    ],
    t: [3, -2, 5],
  };
}

/** The placement that turns `angle` about the z axis through the origin. */
export function zTurn(angle: number): Placement {
  const c = cos(angle);
  const s = sin(angle);
  return {
    rot: [
      [c, -s, 0],
      [s, c, 0],
      [0, 0, 1],
    ],
    t: [0, 0, 0],
  };
}

export function mapP(p: Placement, q: P3): P3 {
  const r = p.rot;
  return [
    r[0][0] * q[0] + r[0][1] * q[1] + r[0][2] * q[2] + p.t[0],
    r[1][0] * q[0] + r[1][1] * q[1] + r[1][2] * q[2] + p.t[1],
    r[2][0] * q[0] + r[2][1] * q[1] + r[2][2] * q[2] + p.t[2],
  ];
}

/** Largest error between two points, relative to max(1, |want|) per coordinate. */
export function relErr(got: P3, want: P3): number {
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    const w = want[i] as number;
    worst = Math.max(worst, Math.abs((got[i] as number) - w) / Math.max(1, Math.abs(w)));
  }
  return worst;
}

const GRID = 7;

/**
 * Largest relative deviation between every NURBS surface and curve of `moved` and the placement of
 * the matching `orig` entity, sampled on a regular interior grid. Shapes keep entity order under
 * transformShape, so index pairing is exact.
 */
export function deviation(orig: Shape, moved: Shape, p: Placement): number {
  let worst = 0;
  orig.surfaces.forEach((a, i) => {
    const b = moved.surfaces[i];
    if (a.kind !== 'nurbs' || b === undefined) return;
    const d = surfaceDomain(a);
    for (let iu = 0; iu < GRID; iu++) {
      for (let iv = 0; iv < GRID; iv++) {
        const u = d.uMin + ((d.uMax - d.uMin) * (iu + 0.5)) / GRID;
        const v = d.vMin + ((d.vMax - d.vMin) * (iv + 0.5)) / GRID;
        worst = Math.max(worst, relErr(surfacePoint(b, u, v), mapP(p, surfacePoint(a, u, v))));
      }
    }
  });
  orig.curves.forEach((a, i) => {
    const b = moved.curves[i];
    if (a.kind !== 'nurbs' || b?.kind !== 'nurbs') return;
    const [t0, t1] = curveDomain(a.curve);
    for (let it = 0; it < GRID * GRID; it++) {
      const t = t0 + ((t1 - t0) * (it + 0.5)) / (GRID * GRID);
      worst = Math.max(worst, relErr(curvePoint(b.curve, t), mapP(p, curvePoint(a.curve, t))));
    }
  });
  return worst;
}

/** Largest relative vertex error between a mesh of `orig` mapped by `p` and the mesh of `moved`. */
export function tessellationGap(a: EditMesh, b: EditMesh, p: Placement): number {
  const va = a.vertices();
  const vb = b.vertices();
  if (va.length !== vb.length || a.faces().length !== b.faces().length) return Infinity;
  let worst = 0;
  for (let i = 0; i < va.length; i++) {
    const ia = (va[i] as number) * 3;
    const ib = (vb[i] as number) * 3;
    const want = mapP(p, [a.pos[ia] as number, a.pos[ia + 1] as number, a.pos[ia + 2] as number]);
    const got: P3 = [b.pos[ib] as number, b.pos[ib + 1] as number, b.pos[ib + 2] as number];
    worst = Math.max(worst, relErr(got, want));
  }
  return worst;
}

export function nurbsSurfaceCount(shape: Shape): number {
  return shape.surfaces.filter((s) => s.kind === 'nurbs').length;
}
