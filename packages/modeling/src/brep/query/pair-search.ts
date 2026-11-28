import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../../errors';
import { brepError } from '../types';
import { cross3, dist3, dot3, len3, type P3, sub3 } from '../vec';
import { MinHeap } from './heap';
import { obbDistance, obbSize } from './obb';
import type { Foot, Piece, Stationarity } from './pieces';

export interface SearchOptions {
  /** Stop once the proven gap `upper - lower` is at most this (default `1e-9 * scale`). */
  readonly tol?: number;
  /** The widest gap accepted as a result when the work budget runs out (default `1e-5 * scale`). */
  readonly maxError?: number;
  /** Stop as soon as an actual pair of points at most this far apart is known. */
  readonly stopBelow?: number;
  /** Pair expansions before giving up (default 200000). */
  readonly budget?: number;
}

export interface PairResult {
  readonly distance: number;
  /** `distance` is within `[distance - errorBound, distance]` of the true minimum. */
  readonly errorBound: number;
  readonly pointA: P3;
  readonly pointB: P3;
  readonly footA: Foot;
  readonly footB: Foot;
  readonly expansions: number;
}

interface Pair {
  readonly a: Piece;
  readonly b: Piece;
  readonly lb: number;
  polished: boolean;
}

const PING_PONG = 40;

/** Margin that absorbs the rounding of the direction and spread estimates. */
const SAFETY = 1e-9;

function violated(s: Stationarity | undefined, w: P3, wSpread: number): boolean {
  if (s === undefined || !Number.isFinite(s.spread)) return false;
  const measure = s.kind === 'normal' ? len3(cross3(w, s.dir)) : Math.abs(dot3(w, s.dir));
  return measure > wSpread + s.spread + SAFETY;
}

/**
 * True when no stationary (locally closest) pair can lie in `a` x `b`: the connecting direction
 * stays off the face normal or off the edge-normal plane by more than every bound on its variation.
 * A minimum on a trim rim is a stationary pair of the rim edge, so rim-straddling face pieces are
 * dropped here instead of being refined to the tolerance.
 */
function noStationaryPair(a: Piece, b: Piece, lb: number): boolean {
  if (lb <= 0) return false;
  const d = sub3(a.point, b.point);
  const n = len3(d);
  if (n === 0) return false;
  const w: P3 = [d[0] / n, d[1] / n, d[2] / n];
  const wSpread = (2 * (a.radius + b.radius)) / lb;
  return violated(a.stationarity, w, wSpread) || violated(b.stationarity, w, wSpread);
}

function scaleOf(pieces: readonly Piece[]): number {
  let s = 0;
  for (const p of pieces) {
    const { c, r } = p.bound;
    s = Math.max(s, Math.abs(c[0]) + Math.abs(c[1]) + Math.abs(c[2]) + Math.max(r[0], r[1], r[2]));
  }
  return s;
}

/**
 * Minimum distance between two sets of pieces by branch and bound: a pair is dropped only when its
 * box lower bound shows it cannot beat the best actual pair of points found so far. Pieces split
 * until the proven gap is within `tol`; that is also the error bound reported.
 */
export function searchPairs(
  setA: readonly Piece[],
  setB: readonly Piece[],
  options: SearchOptions = {},
): Result<PairResult, ModelingError> {
  if (setA.length === 0 || setB.length === 0)
    return err(
      brepError('brep-bad-argument', 'non-empty piece sets', { reason: 'distance-empty' }),
    );
  const scale = Math.max(scaleOf(setA), scaleOf(setB), 1e-300);
  const tol = options.tol ?? 1e-9 * scale;
  const maxError = options.maxError ?? 1e-5 * scale;
  const budget = options.budget ?? 200000;
  const stopBelow = options.stopBelow ?? -1;

  let ub = Infinity;
  let best: { pa: P3; pb: P3; fa: Foot; fb: Foot } | undefined;
  const offer = (pa: P3, pb: P3, fa: Foot, fb: Foot): void => {
    const d = dist3(pa, pb);
    if (d < ub) {
      ub = d;
      best = { pa, pb, fa, fb };
    }
  };
  let lowest = Infinity;
  const heap = new MinHeap<Pair>();
  const push = (a: Piece, b: Piece): void => {
    const lb = obbDistance(a.bound, b.bound);
    if (lb >= ub - tol) {
      if (lb < lowest) lowest = lb;
      return;
    }
    if (noStationaryPair(a, b, lb)) return;
    const centres = dist3(a.point, b.point);
    if (a.valid && b.valid) offer(a.point, b.point, a.foot(), b.foot());
    const spread =
      a.valid && b.valid ? Math.max(0, centres - lb) : 2 * (obbSize(a.bound) + obbSize(b.bound));
    heap.push(lb + 0.1 * spread, { a, b, lb, polished: false });
  };
  for (const a of setA) for (const b of setB) push(a, b);

  let expansions = 0;
  while (heap.size > 0 && ub > stopBelow) {
    const pair = heap.pop() as Pair;
    if (pair.lb >= ub - tol) {
      if (pair.lb < lowest) lowest = pair.lb;
      continue;
    }
    if (++expansions > budget) {
      if (pair.lb < lowest) lowest = pair.lb;
      break;
    }
    if (!pair.polished) {
      pair.polished = true;
      let pa = pair.a.point;
      let pb = pair.b.point;
      let fa = pair.a.foot();
      let fb = pair.b.foot();
      let prev = ub;
      for (let k = 0; k < PING_PONG; k++) {
        const qb = pair.b.polish?.(pa);
        if (qb) {
          pb = qb.point;
          fb = qb.foot;
          offer(pa, pb, fa, fb);
        }
        const qa = pair.a.polish?.(pb);
        if (qa) {
          pa = qa.point;
          fa = qa.foot;
          offer(pa, pb, fa, fb);
        }
        if (!qa && !qb) break;
        if (prev - ub <= 1e-15 * scale) break;
        prev = ub;
      }
      if (pair.lb >= ub - tol) {
        if (pair.lb < lowest) lowest = pair.lb;
        continue;
      }
    }
    const sa = obbSize(pair.a.bound);
    const sb = obbSize(pair.b.bound);
    const first = sa >= sb ? pair.a : pair.b;
    const kids = first.split();
    if (kids === undefined) {
      const other = first === pair.a ? pair.b : pair.a;
      const kids2 = other.split();
      if (kids2 === undefined) {
        if (pair.lb < lowest) lowest = pair.lb;
        continue;
      }
      for (const k of kids2) push(first === pair.a ? pair.a : k, first === pair.a ? k : pair.b);
      continue;
    }
    for (const k of kids) push(first === pair.a ? k : pair.a, first === pair.a ? pair.b : k);
  }
  // Anything still queued (budget, early stop) bounds the gap from below.
  for (;;) {
    const rest = heap.pop();
    if (!rest) break;
    if (rest.lb < lowest) lowest = rest.lb;
  }
  if (!best)
    return err(
      brepError('brep-tol-exceeded', 'a pair of valid points', { reason: 'distance-no-candidate' }),
    );
  const gap = Math.max(0, ub - Math.min(lowest, ub));
  if (gap > maxError && ub > stopBelow)
    return err(
      brepError('brep-tol-exceeded', `a distance gap of at most ${maxError}`, {
        reason: 'distance-budget',
        upper: ub,
        gap,
        expansions,
      }),
    );
  return ok({
    distance: ub,
    errorBound: gap,
    pointA: best.pa,
    pointB: best.pb,
    footA: best.fa,
    footB: best.fb,
    expansions,
  });
}
