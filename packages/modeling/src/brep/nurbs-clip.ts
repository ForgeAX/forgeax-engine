import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { curvePoint } from './curves';
import type { Curve } from './types';
import { brepFail } from './types';
import { cross3, dist3, dot3, len3, madd3, type P2, type P3, sub3 } from './vec';

/**
 * S2a: clip a branch parameter interval to a planar face polygon. Pure: the caller gives the
 * branch curve, its parameter range, and the face outer loop in order (counter-clockwise about
 * `normal`). The result is the single sub-interval where the branch lies inside the polygon, with
 * both ends bisected onto the boundary so each is within `tol` of a boundary edge.
 *
 * Inside/outside is decided by 2D ray parity in the face plane. A branch that touches the
 * interior zero times, enters and leaves more than once, or never crosses the boundary within the
 * range is refused with a reason rather than approximated.
 */
export interface ClippedInterval {
  readonly t0: number;
  readonly t1: number;
  readonly p0: P3;
  readonly p1: P3;
}

const SAMPLES = 128;
const BISECT = 80;

/** In-plane 2D frame for the face: origin at loop[0], axes u and v with u x v = normal. */
function planeFrame(loop: readonly P3[], normal: P3): { o: P3; u: P3; v: P3 } {
  const o = loop[0] as P3;
  const n = unitOf(normal);
  const seed: P3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unitOf(cross3(seed, n));
  const v = cross3(n, u);
  return { o, u, v };
}

function unitOf(a: P3): P3 {
  const l = len3(a);
  return [a[0] / l, a[1] / l, a[2] / l];
}

function project(f: { o: P3; u: P3; v: P3 }, p: P3): P2 {
  const d = sub3(p, f.o);
  return [dot3(d, f.u), dot3(d, f.v)];
}

function insidePolygon(poly: readonly P2[], p: P2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as P2;
    const b = poly[j] as P2;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** Distance from `p` to the nearest boundary segment of the polygon (3D, on the face plane). */
function boundaryDistance(loop: readonly P3[], p: P3): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] as P3;
    const b = loop[(i + 1) % loop.length] as P3;
    const e = sub3(b, a);
    const l2 = dot3(e, e);
    const s = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot3(sub3(p, a), e) / l2));
    best = Math.min(best, dist3(p, madd3(a, e, s)));
  }
  return best;
}

export function clipBranchToFace(
  curve: Curve,
  t0: number,
  t1: number,
  loop: readonly P3[],
  normal: P3,
  tol: number,
): Result<ClippedInterval, ModelingError> {
  if (loop.length < 3) return brepFail('brep-bad-argument', 'a face loop with three corners', {});
  if (!(t1 > t0))
    return brepFail('brep-bad-argument', 'an increasing parameter range', {
      t0,
      t1,
    });
  if (len3(normal) === 0) return brepFail('brep-bad-argument', 'a non-zero face normal', {});

  const f = planeFrame(loop, normal);
  const poly = loop.map((p) => project(f, p));
  const flags: boolean[] = [];
  const ts: number[] = [];
  for (let k = 0; k <= SAMPLES; k++) {
    const t = t0 + ((t1 - t0) * k) / SAMPLES;
    ts.push(t);
    flags.push(insidePolygon(poly, project(f, curvePoint(curve, t))));
  }

  // Exactly one inside run, bounded by sign changes; anything else is refused.
  const changes: number[] = [];
  for (let k = 1; k < flags.length; k++) if (flags[k] !== flags[k - 1]) changes.push(k);
  if (changes.length === 0)
    return brepFail('brep-ssi-unsupported', 'a branch crossing the face boundary', {
      reason: 'clip-no-crossing',
    });
  if (changes.length !== 2 || flags[0] !== false || flags[SAMPLES] !== false)
    return brepFail('brep-ssi-unsupported', 'a branch entering the face once', {
      reason: 'clip-crossing-count',
      count: changes.length,
    });

  const bisect = (a: number, b: number, insideAtA: boolean): number => {
    let lo = a;
    let hi = b;
    for (let i = 0; i < BISECT; i++) {
      const mid = (lo + hi) / 2;
      const isIn = insidePolygon(poly, project(f, curvePoint(curve, mid)));
      if (isIn === insideAtA) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const lo = bisect(
    ts[(changes[0] as number) - 1] as number,
    ts[changes[0] as number] as number,
    false,
  );
  const hi = bisect(
    ts[(changes[1] as number) - 1] as number,
    ts[changes[1] as number] as number,
    true,
  );
  const p0 = curvePoint(curve, lo);
  const p1 = curvePoint(curve, hi);
  if (boundaryDistance(loop, p0) > tol || boundaryDistance(loop, p1) > tol)
    return brepFail('brep-ssi-unsupported', 'clip endpoints on the face boundary', {
      reason: 'clip-off-boundary',
    });
  if (dist3(p0, p1) <= tol)
    return brepFail('brep-ssi-unsupported', 'a clipped interval with non-zero length', {
      reason: 'clip-degenerate',
    });
  return ok({ t0: lo, t1: hi, p0, p1 });
}

/** A clipped interval together with the index of the branch it trims. */
export interface ClippedBranch extends ClippedInterval {
  readonly branch: number;
}

/**
 * S2b1: clip every branch of a NURBS x plane pair to the plane face. `loop` is the plane face's
 * outer loop points in order and `normal` its outward normal; each branch is clipped over its own
 * parameter range. A branch that clips to nothing (no interior run) is counted as missing rather
 * than refused, because a branch may cross the window without reaching this face. Returns the
 * clipped intervals; any ambiguous branch fails the whole pair.
 */
export function clipNurbsBranches(
  branches: readonly {
    readonly curve: Curve;
    readonly t0: number;
    readonly t1: number;
  }[],
  loop: readonly P3[],
  normal: P3,
  tol: number,
): Result<readonly ClippedBranch[], ModelingError> {
  const out: ClippedBranch[] = [];
  for (const [branch, b] of branches.entries()) {
    const r = clipBranchToFace(b.curve, b.t0, b.t1, loop, normal, tol);
    if (!r.ok) {
      if (
        r.error.detail &&
        (r.error.detail as Record<string, unknown>).reason === 'clip-no-crossing'
      )
        continue;
      return r;
    }
    out.push({ ...r.value, branch });
  }
  return ok(out);
}
