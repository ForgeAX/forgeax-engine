import type { NurbsSurface } from '../../nurbs';
import { surfaceDomain } from '../../nurbs';
import { surfaceSplit } from '../../nurbs-surface';
import { dist3, type P3 } from '../vec';
import type { ParamBox } from './types';

/** A piece of a NURBS face with its parameter box and the bounds of its control net (which contains it). */
export interface HullNode {
  readonly s: NurbsSurface;
  readonly box: ParamBox;
  readonly lo: P3;
  readonly hi: P3;
  /** Centre and radius of a ball holding the control net. */
  readonly c: P3;
  readonly r: number;
}

export function hullNode(s: NurbsSurface): HullNode {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const row of s.points) {
    for (const p of row) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k] as number, p[k] as number);
        hi[k] = Math.max(hi[k] as number, p[k] as number);
      }
    }
  }
  const c: P3 = [
    0.5 * ((lo[0] as number) + (hi[0] as number)),
    0.5 * ((lo[1] as number) + (hi[1] as number)),
    0.5 * ((lo[2] as number) + (hi[2] as number)),
  ];
  let r = 0;
  for (const row of s.points) for (const p of row) r = Math.max(r, dist3(c, p));
  return { s, box: surfaceDomain(s), lo: lo as unknown as P3, hi: hi as unknown as P3, c, r };
}

function splitAt(
  s: NurbsSurface,
  dir: 'u' | 'v',
  t: number,
): readonly [NurbsSurface, NurbsSurface] | undefined {
  const r = surfaceSplit(s, dir, t);
  return r.ok ? r.value : undefined;
}

/** The part of `s` over `box` (a sub-rectangle of its domain), or undefined if a split fails. */
export function clipToBox(s: NurbsSurface, box: ParamBox): NurbsSurface | undefined {
  let cur: NurbsSurface | undefined = s;
  for (const [k, dir] of [
    [0, 'u'],
    [1, 'v'],
  ] as const) {
    const [lo, hi] = box[k];
    const d = surfaceDomain(cur)[k];
    if (lo > d[0]) cur = splitAt(cur, dir, lo)?.[1];
    if (cur === undefined) return undefined;
    if (hi < surfaceDomain(cur)[k][1]) cur = splitAt(cur, dir, hi)?.[0];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Bezier pieces of `s`: split at every distinct interior knot. */
export function bezierPieces(s: NurbsSurface): NurbsSurface[] {
  let pieces: NurbsSurface[] = [s];
  for (const [k, dir] of [
    [0, 'u'],
    [1, 'v'],
  ] as const) {
    const knots = k === 0 ? s.knotsU : s.knotsV;
    const [lo, hi] = surfaceDomain(s)[k];
    const inner = [...new Set(knots.filter((t) => t > lo && t < hi))].sort((a, b) => a - b);
    const next: NurbsSurface[] = [];
    for (const piece of pieces) {
      let rest: NurbsSurface | undefined = piece;
      for (const t of inner) {
        const d = surfaceDomain(rest)[k];
        if (!(t > d[0] && t < d[1])) continue;
        const parts = splitAt(rest, dir, t);
        if (parts === undefined) break;
        next.push(parts[0]);
        rest = parts[1];
      }
      next.push(rest);
    }
    pieces = next;
  }
  return pieces;
}

/** Halve a node across its longer side in space (measured along the parameter isolines through the net). */
export function splitNode(n: HullNode): readonly [HullNode, HullNode] | undefined {
  const pts = n.s.points;
  const nu = pts.length;
  const nv = (pts[0] as readonly P3[]).length;
  const corner = (i: number, j: number) => (pts[i] as readonly P3[])[j] as P3;
  const lu =
    dist3(corner(0, 0), corner(nu - 1, 0)) + dist3(corner(0, nv - 1), corner(nu - 1, nv - 1));
  const lv =
    dist3(corner(0, 0), corner(0, nv - 1)) + dist3(corner(nu - 1, 0), corner(nu - 1, nv - 1));
  const k = lu >= lv ? 0 : 1;
  const [lo, hi] = n.box[k];
  const parts = splitAt(n.s, k === 0 ? 'u' : 'v', 0.5 * (lo + hi));
  if (parts === undefined) return undefined;
  return [hullNode(parts[0]), hullNode(parts[1])];
}
