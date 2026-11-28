import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../../errors';
import { pcurvePoint } from '../curves';
import { faceLoops } from '../faces';
import { surfaceDomain } from '../surfaces';
import { inTrim, type TrimLoop } from '../trim';
import { brepError, type Coedge, type Edge, type Face, type PCurve, type Shape } from '../types';
import type { P2 } from '../vec';

/** Largest deviation of a trim polyline from its pcurve, in (u, v) units. */
export const TRIM_SAGITTA = 1e-8;
const MAX_DEPTH = 16;
const GRID = 16;

/** Points of the pcurve from `t0` to `t1`, bisected until every chord is within `TRIM_SAGITTA` of the curve. */
function sampleCoedge(pc: PCurve, t0: number, t1: number): P2[] {
  const a = pcurvePoint(pc, t0);
  const b = pcurvePoint(pc, t1);
  if (pc.kind === 'line') return [a, b];
  const out: P2[] = [a];
  const walk = (ta: number, tb: number, pa: P2, pb: P2, depth: number): void => {
    const tm = (ta + tb) / 2;
    const pm = pcurvePoint(pc, tm);
    const dev = Math.abs(pm[0] - (pa[0] + pb[0]) / 2) + Math.abs(pm[1] - (pa[1] + pb[1]) / 2);
    if (dev <= TRIM_SAGITTA || depth >= MAX_DEPTH) {
      out.push(pb);
      return;
    }
    walk(ta, tm, pa, pm, depth + 1);
    walk(tm, tb, pm, pb, depth + 1);
  };
  const seeds = 16;
  let prev = a;
  let tPrev = t0;
  for (let k = 1; k <= seeds; k++) {
    const t = k === seeds ? t1 : t0 + ((t1 - t0) * k) / seeds;
    const p = k === seeds ? b : pcurvePoint(pc, t);
    walk(tPrev, t, prev, p, 0);
    prev = p;
    tPrev = t;
  }
  return out;
}

function ringPoints(shape: Shape, coedges: readonly number[]): P2[] {
  const pts: P2[] = [];
  for (const c of coedges) {
    const co = shape.coedges[c] as Coedge;
    const e = shape.edges[co.edge] as Edge;
    const s = sampleCoedge(co.pcurve, e.t0, e.t1);
    if (co.reversed) s.reverse();
    for (let i = pts.length === 0 ? 0 : 1; i < s.length; i++) pts.push(s[i] as P2);
  }
  pts.pop();
  return pts;
}

/** Whether the segment a-b meets the closed rectangle (Liang-Barsky clip). */
function segmentMeetsRect(a: P2, b: P2, lo: P2, hi: P2): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 2; k++) {
    const d = (b[k] as number) - (a[k] as number);
    for (const [p, q] of [
      [-d, (a[k] as number) - (lo[k] as number)],
      [d, (hi[k] as number) - (a[k] as number)],
    ] as const) {
      if (p === 0) {
        if (q < 0) return false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
        if (t0 > t1) return false;
      }
    }
  }
  return true;
}

/** The trimmed (u, v) region of one face: membership, and a conservative test of a rectangle. */
export interface TrimIndex {
  readonly lo: P2;
  readonly hi: P2;
  contains(u: number, v: number): boolean;
  /** False only when the rectangle certainly holds no point of the face. */
  mayTouch(lo: readonly number[], hi: readonly number[]): boolean;
}

export function trimIndexOf(shape: Shape, f: number): Result<TrimIndex, ModelingError> {
  const face = shape.faces[f] as Face;
  const { outer, holes } = faceLoops(shape, f);
  if (outer.length === 0)
    return err(brepError('brep-loop-open', 'a face with an outer loop', { face: f }));
  const loops: TrimLoop[] = [
    { points: ringPoints(shape, outer), outer: true },
    ...holes.map((h) => ({ points: ringPoints(shape, h), outer: false })),
  ];
  const periods = surfaceDomain(shape.surfaces[face.surface] as Shape['surfaces'][number]);
  const period = { u: periods.uPeriod, v: periods.vPeriod };
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const l of loops)
    for (const p of l.points) {
      if (p[0] < u0) u0 = p[0];
      if (p[0] > u1) u1 = p[0];
      if (p[1] < v0) v0 = p[1];
      if (p[1] > v1) v1 = p[1];
    }
  if (!(u1 >= u0 && v1 >= v0 && Number.isFinite(u0 + u1 + v0 + v1)))
    return err(brepError('brep-loop-open', 'a face with finite trim loops', { face: f }));
  const du = (u1 - u0) / GRID || 1;
  const dv = (v1 - v0) / GRID || 1;
  const cell = (x: number, lo: number, d: number): number =>
    Math.min(GRID - 1, Math.max(0, Math.floor((x - lo) / d)));
  // 0 outside, 1 inside, 2 crossed by a trim segment (conservative: the segment's box marks buckets).
  const state = new Uint8Array(GRID * GRID);
  for (const l of loops) {
    const n = l.points.length;
    for (let i = 0; i < n; i++) {
      const a = l.points[i] as P2;
      const b = l.points[(i + 1) % n] as P2;
      const i0 = cell(Math.min(a[0], b[0]), u0, du);
      const i1 = cell(Math.max(a[0], b[0]), u0, du);
      const j0 = cell(Math.min(a[1], b[1]), v0, dv);
      const j1 = cell(Math.max(a[1], b[1]), v0, dv);
      for (let x = i0; x <= i1; x++) for (let y = j0; y <= j1; y++) state[x * GRID + y] = 2;
    }
  }
  for (let x = 0; x < GRID; x++)
    for (let y = 0; y < GRID; y++)
      if (state[x * GRID + y] !== 2)
        state[x * GRID + y] = inTrim(loops, [u0 + (x + 0.5) * du, v0 + (y + 0.5) * dv], period)
          ? 1
          : 0;
  // A cell crossed by a trim segment is undecided; a rectangle inside it is settled exactly, so that
  // pieces deep inside a hole are pruned instead of refining to the depth limit.
  const shifts = (a0: number, a1: number, lo: number, hi: number, per: number): number[] => {
    if (per <= 0) return [0];
    const out: number[] = [];
    for (let k = Math.ceil((lo - a1) / per); k * per + a0 <= hi; k++) out.push(k * per);
    return out;
  };
  const pad = 4 * TRIM_SAGITTA;
  const settled = (a0: number, a1: number, b0: number, b1: number): boolean => {
    for (const su of shifts(a0, a1, u0, u1, period.u))
      for (const sv of shifts(b0, b1, v0, v1, period.v)) {
        const lo: P2 = [a0 + su - pad, b0 + sv - pad];
        const hi: P2 = [a1 + su + pad, b1 + sv + pad];
        for (const l of loops) {
          const n = l.points.length;
          for (let i = 0; i < n; i++)
            if (segmentMeetsRect(l.points[i] as P2, l.points[(i + 1) % n] as P2, lo, hi))
              return false;
        }
      }
    return !inTrim(loops, [(a0 + a1) / 2, (b0 + b1) / 2], period);
  };
  return ok({
    lo: [u0, v0],
    hi: [u1, v1],
    contains: (u, v) => inTrim(loops, [u, v], period),
    mayTouch: (lo, hi) => {
      const a0 = lo[0] as number;
      const a1 = hi[0] as number;
      const b0 = lo[1] as number;
      const b1 = hi[1] as number;
      if (a1 < u0 || a0 > u1 || b1 < v0 || b0 > v1) return false;
      const i0 = cell(a0, u0, du);
      const i1 = cell(a1, u0, du);
      const j0 = cell(b0, v0, dv);
      const j1 = cell(b1, v0, dv);
      let crossed = false;
      for (let x = i0; x <= i1; x++)
        for (let y = j0; y <= j1; y++) {
          const st = state[x * GRID + y];
          if (st === 1) return true;
          if (st === 2) crossed = true;
        }
      return crossed && !settled(a0, a1, b0, b1);
    },
  });
}
