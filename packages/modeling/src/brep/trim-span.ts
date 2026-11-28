import { pushAll } from '../arrays';
import { cos, sin } from '../dmath';
import { curvePoint } from './curves';
import { type BranchPCurve, branchPCurvePoint, type IntersectionBranch } from './intersect';
import { surfaceDomain, surfaceInverse } from './surfaces';
import type { Surface } from './types';
import { dist3, dot3, madd3, type P2, type P3, sub3 } from './vec';

/**
 * E1b step 1: cut an intersection branch where it leaves the principal parameter domain of either
 * surface. A periodic seam crossing (the `u = 0` half-plane, the torus `v = 0` half-plane) and a pole
 * or apex passage end a span, so every span maps into one sheet of each surface with a whole-period
 * shift of its pcurve, as the half-open rule `u in [0, 2 pi)` requires.
 */
export type SpanCutKind = 'u-seam' | 'v-seam' | 'pole' | 'apex';

export interface SpanCut {
  readonly t: number;
  readonly on: 'a' | 'b';
  readonly kind: SpanCutKind;
  readonly p: P3;
}

/** A piece of a branch inside one sheet of both surfaces; `shiftA`/`shiftB` move its pcurve there. */
export interface BranchSpan {
  readonly t0: number;
  readonly t1: number;
  readonly shiftA: P2;
  readonly shiftB: P2;
}

export interface BranchSpans {
  readonly cuts: readonly SpanCut[];
  readonly spans: readonly BranchSpan[];
}

/** Samples along a branch: enough that two seam crossings never share one sample interval in the corpus. */
export const SPAN_SAMPLES = 1024;
const BISECT = 80;

type Side = (p: P3) => { s: number; ok: boolean };

/** The seam half-planes of a surface, each as a signed function and the side on which it is the seam. */
function seams(s: Surface): { kind: SpanCutKind; side: Side }[] {
  if (s.kind === 'plane' || s.kind === 'nurbs') return [];
  const f = s.frame;
  const local = (p: P3) => {
    const d = sub3(p, f.o);
    return { lx: dot3(d, f.x), ly: dot3(d, f.y), lz: dot3(d, f.z) };
  };
  const out: { kind: SpanCutKind; side: Side }[] = [];
  if (s.kind === 'cone') {
    const sa = sin(s.halfAngle);
    const ca = cos(s.halfAngle);
    // Below the apex the signed radius is negative, so `u = 0` is the opposite half-plane.
    out.push({
      kind: 'u-seam',
      side: (p) => {
        const { lx, ly, lz } = local(p);
        const lower = lz * sa + s.radius * ca < 0;
        return { s: ly, ok: lower ? lx < 0 : lx > 0 };
      },
    });
  } else {
    out.push({
      kind: 'u-seam',
      side: (p) => {
        const { lx, ly } = local(p);
        return { s: ly, ok: lx > 0 };
      },
    });
  }
  if (s.kind === 'torus') {
    out.push({
      kind: 'v-seam',
      side: (p) => {
        const { lx, ly, lz } = local(p);
        const rho = Math.sqrt(lx * lx + ly * ly);
        return { s: lz, ok: rho > s.major };
      },
    });
  }
  return out;
}

/** Points of a surface where `u` is undefined: sphere poles and the cone apex. */
function singular(s: Surface): { kind: SpanCutKind; p: P3 }[] {
  if (s.kind === 'sphere') {
    return [
      { kind: 'pole', p: madd3(s.frame.o, s.frame.z, s.radius) },
      { kind: 'pole', p: madd3(s.frame.o, s.frame.z, -s.radius) },
    ];
  }
  if (s.kind === 'cone') {
    return [
      {
        kind: 'apex',
        p: madd3(s.frame.o, s.frame.z, (-s.radius * cos(s.halfAngle)) / sin(s.halfAngle)),
      },
    ];
  }
  return [];
}

/** Scale below which a seam-function sample counts as exactly on the seam plane. */
function zeroBand(s: Surface): number {
  if (s.kind === 'plane' || s.kind === 'nurbs') return 0;
  const size = s.kind === 'torus' ? s.major + s.minor : Math.max(s.radius, 1);
  return 1e-12 * size;
}

function seamCuts(
  s: Surface,
  on: 'a' | 'b',
  at: (t: number) => P3,
  ts: readonly number[],
  closed: boolean,
): SpanCut[] {
  const cuts: SpanCut[] = [];
  const band = zeroBand(s);
  for (const seam of seams(s)) {
    const side = ts.map((t) => seam.side(at(t)));
    // A sample on the seam plane is not a side: compare the nearest nonzero neighbours.
    const idx: number[] = [];
    for (let i = 0; i < ts.length; i++) {
      if (Math.abs((side[i] as { s: number }).s) > band) idx.push(i);
    }
    const pairs: [number, number][] = [];
    for (let k = 0; k + 1 < idx.length; k++) pairs.push([idx[k] as number, idx[k + 1] as number]);
    if (closed && idx.length > 1) pairs.push([idx[idx.length - 1] as number, idx[0] as number]);
    for (const [i, j] of pairs) {
      const p = side[i] as { s: number; ok: boolean };
      const q = side[j] as { s: number; ok: boolean };
      if (p.s < 0 === q.s < 0 || !p.ok || !q.ok) continue;
      let lo = ts[i] as number;
      let hi =
        j > i
          ? (ts[j] as number)
          : (ts[j] as number) + (ts[ts.length - 1] as number) - (ts[0] as number);
      const span = (ts[ts.length - 1] as number) - (ts[0] as number);
      const wrapT = (t: number) => (t > (ts[ts.length - 1] as number) ? t - span : t);
      const neg = p.s < 0;
      for (let k = 0; k < BISECT; k++) {
        const mid = 0.5 * (lo + hi);
        if (mid === lo || mid === hi) break;
        if (seam.side(at(wrapT(mid))).s < 0 === neg) lo = mid;
        else hi = mid;
      }
      const t = wrapT(0.5 * (lo + hi));
      cuts.push({ t, on, kind: seam.kind, p: at(t) });
    }
  }
  return cuts;
}

const GOLDEN = 0.6180339887498949;

function poleCuts(
  s: Surface,
  on: 'a' | 'b',
  at: (t: number) => P3,
  ts: readonly number[],
  closed: boolean,
  tol: number,
): SpanCut[] {
  const cuts: SpanCut[] = [];
  const n = ts.length;
  for (const pole of singular(s)) {
    const d = ts.map((t) => dist3(at(t), pole.p));
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? i - 1 : closed ? n - 2 : -1;
      const next = i + 1 < n ? i + 1 : closed ? 1 : -1;
      if (closed && i === n - 1) continue;
      const di = d[i] as number;
      if (prev >= 0 && (d[prev] as number) < di) continue;
      if (next >= 0 && (d[next] as number) <= di) continue;
      // Golden-section search for the closest approach on the neighbouring sample intervals.
      let lo = prev >= 0 && prev < i ? (ts[prev] as number) : (ts[i] as number);
      let hi = next > i ? (ts[next] as number) : (ts[i] as number);
      let x1 = hi - GOLDEN * (hi - lo);
      let x2 = lo + GOLDEN * (hi - lo);
      let f1 = dist3(at(x1), pole.p);
      let f2 = dist3(at(x2), pole.p);
      for (let k = 0; k < BISECT && hi - lo > 0; k++) {
        if (f1 < f2) {
          hi = x2;
          x2 = x1;
          f2 = f1;
          x1 = hi - GOLDEN * (hi - lo);
          f1 = dist3(at(x1), pole.p);
        } else {
          lo = x1;
          x1 = x2;
          f1 = f2;
          x2 = lo + GOLDEN * (hi - lo);
          f2 = dist3(at(x2), pole.p);
        }
      }
      const t = f1 < f2 ? x1 : x2;
      const best = Math.min(f1, f2, di);
      if (best <= tol)
        cuts.push({ t: best === di ? (ts[i] as number) : t, on, kind: pole.kind, p: pole.p });
    }
  }
  return cuts;
}

/** Whole-period shift that maps the pcurve point at `t` into the principal domain of `s`. */
function shiftAt(s: Surface, pc: BranchPCurve, p: P3, t: number): P2 {
  const dom = surfaceDomain(s);
  if (dom.uPeriod === 0 && dom.vPeriod === 0) return [0, 0];
  const uv = branchPCurvePoint(pc, t);
  const inv = surfaceInverse(s, p);
  const du = dom.uPeriod > 0 ? Math.round((inv.u - uv[0]) / dom.uPeriod) * dom.uPeriod : 0;
  const dv = dom.vPeriod > 0 ? Math.round((inv.v - uv[1]) / dom.vPeriod) * dom.vPeriod : 0;
  return [du, dv];
}

/**
 * Cut `branch` (an intersection of `a` and `b`) at every seam crossing, pole and apex of either
 * surface. A closed branch with cuts starts its first span at its own start, so a span never wraps
 * past `t1`; the start is then a break, not a cut. Cuts within one part in 1e12 of an end are dropped.
 */
export function cutBranch(
  a: Surface,
  b: Surface,
  branch: IntersectionBranch,
  tol: number,
  samples = SPAN_SAMPLES,
): BranchSpans {
  const at = (t: number): P3 => curvePoint(branch.curve, t);
  const ts: number[] = [];
  for (let i = 0; i <= samples; i++) ts.push(branch.t0 + ((branch.t1 - branch.t0) * i) / samples);
  const cuts: SpanCut[] = [];
  for (const [s, on] of [
    [a, 'a'],
    [b, 'b'],
  ] as const) {
    // A seam sign change at a pole or apex is that passage itself (the axis flips `u` by a half
    // turn there), so it is reported once, as the singular cut.
    const points = singular(s).map((q) => q.p);
    for (const c of seamCuts(s, on, at, ts, branch.closed)) {
      if (points.every((q) => dist3(q, c.p) > tol)) cuts.push(c);
    }
    pushAll(cuts, poleCuts(s, on, at, ts, branch.closed, tol));
  }
  cuts.sort((x, y) => x.t - y.t);
  const eps = 1e-12 * Math.max(1, Math.abs(branch.t1 - branch.t0));
  const breaks = [branch.t0];
  for (const c of cuts) {
    if (c.t - (breaks[breaks.length - 1] as number) > eps && branch.t1 - c.t > eps)
      breaks.push(c.t);
  }
  breaks.push(branch.t1);
  const spans: BranchSpan[] = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const t0 = breaks[i] as number;
    const t1 = breaks[i + 1] as number;
    const tm = 0.5 * (t0 + t1);
    const p = at(tm);
    spans.push({
      t0,
      t1,
      shiftA: shiftAt(a, branch.onA, p, tm),
      shiftB: shiftAt(b, branch.onB, p, tm),
    });
  }
  return { cuts, spans };
}
