import { pushAll } from '../../arrays';
import { hypot3 } from '../../dmath';
import { dist3, type P3 } from '../vec';
import type { FaceCurve } from './contour';

/** A curve of one or more faces joined end to end where their endpoints coincide. */
export interface JoinedCurve {
  readonly points: readonly P3[];
  readonly closed: boolean;
  /** Faces the curve passes through, in order (consecutive repeats removed). */
  readonly faces: readonly number[];
}

interface End {
  readonly curve: number;
  readonly atStart: boolean;
  readonly p: P3;
}

/**
 * Joins open face curves whose endpoints lie within `eps`. An endpoint with more than one candidate
 * partner (a branch point, for example a plane through a vertex) is left unjoined, never guessed.
 */
export function stitch(curves: readonly FaceCurve[], eps: number): JoinedCurve[] {
  const ends: End[] = [];
  curves.forEach((c, i) => {
    if (c.closed) return;
    ends.push({ curve: i, atStart: true, p: c.points[0] as P3 });
    ends.push({ curve: i, atStart: false, p: c.points[c.points.length - 1] as P3 });
  });
  const partner = new Map<End, End>();
  for (const a of ends) {
    const near = ends.filter((b) => b !== a && dist3(a.p, b.p) <= eps);
    if (near.length === 1) partner.set(a, near[0] as End);
  }
  const mutual = (a: End): End | undefined => {
    const b = partner.get(a);
    return b !== undefined && partner.get(b) === a ? b : undefined;
  };
  const endOf = (curve: number, atStart: boolean): End =>
    ends.find((e) => e.curve === curve && e.atStart === atStart) as End;

  const used = new Uint8Array(curves.length);
  const out: JoinedCurve[] = [];
  const emit = (first: number, forward: boolean): void => {
    const points: P3[] = [];
    const faces: number[] = [];
    let i = first;
    let fwd = forward;
    let closed = false;
    for (;;) {
      used[i] = 1;
      const c = curves[i] as FaceCurve;
      const pts = fwd ? c.points : [...c.points].reverse();
      pushAll(points, points.length === 0 ? pts : pts.slice(1));
      if (faces[faces.length - 1] !== c.face) faces.push(c.face);
      const next = mutual(endOf(i, !fwd));
      if (next === undefined) break;
      if (next.curve === first) {
        closed = true;
        break;
      }
      if (used[next.curve]) break;
      i = next.curve;
      fwd = next.atStart;
    }
    if (closed) points.pop();
    out.push({ points, closed, faces });
  };
  // Open chains start at an unjoined end; what remains are cycles.
  curves.forEach((c, i) => {
    if (c.closed || used[i]) return;
    if (mutual(endOf(i, true)) === undefined) emit(i, true);
    else if (mutual(endOf(i, false)) === undefined) emit(i, false);
  });
  curves.forEach((c, i) => {
    if (used[i]) return;
    if (c.closed) {
      used[i] = 1;
      out.push({ points: c.points, closed: true, faces: [c.face] });
    } else emit(i, true);
  });
  return out;
}

/** Why an open chain end was not joined; `junction` means three or more ends met within tolerance. */
export type ChainEndReason = 'gap-over-tol' | 'junction' | 'boundary' | 'open';

export interface ChainEnd {
  readonly point: P3;
  /** Measured distance to the nearest end of another branch; null when no other branch exists. */
  readonly gap: number | null;
  readonly reason: ChainEndReason;
}

/** A branch reduced to what joining needs: its two end points and whether it is closed. */
export interface JoinBranch {
  readonly closed: boolean;
  readonly ends: readonly [P3, P3];
  /** The marcher's stop reason at each end, when known (SsiBranch.ends). */
  readonly stops?: readonly [string, string];
}

export interface JoinedChain {
  readonly branches: readonly number[];
  readonly closed: boolean;
  readonly ends: readonly ChainEnd[];
}

/**
 * Join branch end points within `eps`. A point with exactly one partner is joined only when that
 * partner also points back at it; a point with two or more candidates is a `junction` and is never
 * paired. Open ends carry their measured gap and reason, so a caller can report unmatched ends
 * instead of guessing. Closed input branches are returned as their own loops.
 */
export function joinBranches(branches: readonly JoinBranch[], eps: number): JoinedChain[] {
  const dist = (a: P3, b: P3) => hypot3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  type Ref = { branch: number; end: 0 | 1 };
  const refs: Ref[] = [];
  branches.forEach((b, i) => {
    if (b.closed) return;
    refs.push({ branch: i, end: 0 }, { branch: i, end: 1 });
  });
  const pointOf = (r: Ref) => (branches[r.branch] as JoinBranch).ends[r.end];
  const near = (r: Ref) =>
    refs.filter((s) => s.branch !== r.branch && dist(pointOf(r), pointOf(s)) <= eps);
  const nearestGap = (r: Ref): number | null => {
    let best: number | null = null;
    for (const s of refs) {
      if (s.branch === r.branch) continue;
      const d = dist(pointOf(r), pointOf(s));
      if (best === null || d < best) best = d;
    }
    return best;
  };
  const key = (r: Ref) => r.branch * 2 + r.end;
  const partner = new Map<number, Ref>();
  const reason = new Map<number, ChainEndReason>();
  for (const r of refs) {
    const cands = near(r);
    if (cands.length === 0) {
      const stop = branches[r.branch]?.stops?.[r.end];
      reason.set(key(r), stop === 'boundary' ? 'boundary' : 'gap-over-tol');
    } else if (cands.length >= 2) {
      reason.set(key(r), 'junction');
    } else {
      partner.set(key(r), cands[0] as Ref);
    }
  }
  // Keep a pairing only when both sides agree and neither side is a junction.
  for (const r of refs) {
    const p = partner.get(key(r));
    if (p === undefined) continue;
    const back = partner.get(key(p));
    if (back === undefined || key(back) !== key(r)) {
      partner.delete(key(r));
      reason.set(key(r), 'junction');
    }
  }
  const used = new Set<number>();
  const out: JoinedChain[] = [];
  branches.forEach((b, i) => {
    if (b.closed) out.push({ branches: [i], closed: true, ends: [] });
  });
  const walk = (start: Ref): void => {
    const seq: number[] = [start.branch];
    used.add(start.branch);
    let exit: Ref = { branch: start.branch, end: start.end === 0 ? 1 : 0 };
    let closed = false;
    for (;;) {
      const p = partner.get(key(exit));
      if (p === undefined) break;
      if (p.branch === start.branch) {
        closed = true;
        break;
      }
      if (used.has(p.branch)) break;
      used.add(p.branch);
      seq.push(p.branch);
      exit = { branch: p.branch, end: p.end === 0 ? 1 : 0 };
    }
    const endRefs = closed ? [] : [start, exit];
    out.push({
      branches: seq,
      closed,
      ends: endRefs.map((r) => ({
        point: pointOf(r),
        gap: nearestGap(r),
        reason: reason.get(key(r)) ?? 'open',
      })),
    });
  };
  for (const r of refs) {
    if (used.has(r.branch) || partner.has(key(r))) continue;
    walk(r);
  }
  for (const r of refs) if (!used.has(r.branch)) walk(r);
  return out;
}

/** Adapter for an `SsiBranch`: its ends are the first and last marched points. */
export function fromSsiBranch(b: {
  readonly closed: boolean;
  readonly points: readonly P3[];
  readonly ends: readonly [string, string];
}): JoinBranch {
  const first = b.points[0] as P3;
  const last = b.points[b.points.length - 1] as P3;
  return { closed: b.closed, ends: [first, last], stops: [b.ends[0], b.ends[1]] };
}

/** Adapter for an `IntersectionBranch`: its ends are the curve evaluated at t0 and t1. */
export function fromIntersectionBranch(
  b: {
    readonly closed: boolean;
    readonly t0: number;
    readonly t1: number;
    readonly curve: unknown;
  },
  at: (curve: unknown, t: number) => P3,
): JoinBranch {
  return { closed: b.closed, ends: [at(b.curve, b.t0), at(b.curve, b.t1)] };
}
