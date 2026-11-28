import { atan2 } from '../../dmath';
import { cross3, dist3, dot3, len3, madd3, type P3, sub3 } from '../vec';
import type { Local, Problem } from './problem';
import type { SsiEnd } from './types';

/** Step-size policy of one march, in model units. */
export interface MarchControl {
  readonly hMax: number;
  readonly hMin: number;
  /** Largest chord sag between consecutive points. */
  readonly sag: number;
  readonly minAngle: number;
  /** Shared step budget; decremented by every accepted step. */
  readonly budget: { left: number };
}

export interface Traced {
  readonly xs: readonly (readonly number[])[];
  readonly points: readonly P3[];
  readonly closed: boolean;
  /** Indices of points that lie exactly on a crease (C0 knot line) of a face. */
  readonly kinks: readonly number[];
  readonly ends: readonly [SsiEnd, SsiEnd];
  /** Where each open end stopped for a reason other than a boundary. */
  readonly stops: readonly P3[];
}

const BISECT = 48;
const GROW = 1.5;

interface Run {
  readonly xs: number[][];
  readonly points: P3[];
  readonly kinks: number[];
  end: SsiEnd;
}

function nudged(problem: Problem, x: readonly number[], from: readonly number[] | undefined) {
  if (from === undefined) return x;
  for (const k of problem.kinks) {
    if (Math.abs((x[k.index] as number) - k.value) <= 1e-12 * Math.max(1, Math.abs(k.value))) {
      const dir = Math.sign((x[k.index] as number) - (from[k.index] as number)) || 1;
      const y = [...x];
      y[k.index] = k.value + dir * 1e-9 * Math.max(1, Math.abs(k.value));
      return y;
    }
  }
  return x;
}

/** Local frame at `x`, evaluated on the side of any crease that `prev` did not come from. */
function localAt(
  problem: Problem,
  x: readonly number[],
  prev: readonly number[] | undefined,
): Local | undefined {
  const l = problem.local(nudged(problem, x, prev));
  if (l === undefined) return undefined;
  return { ...l, p: problem.point(x) };
}

function turn(a: P3, b: P3): number {
  return atan2(len3(cross3(a, b)), dot3(a, b));
}

/** Crease crossed between `x` and `y`: the first by fraction along the segment. */
function creaseBetween(problem: Problem, x: readonly number[], y: readonly number[]) {
  let best: { index: number; value: number; f: number } | undefined;
  for (const k of problem.kinks) {
    const a = (x[k.index] as number) - k.value;
    const b = (y[k.index] as number) - k.value;
    const scale = 1e-12 * Math.max(1, Math.abs(k.value));
    if ((a > scale && b < -scale) || (a < -scale && b > scale)) {
      const f = a / (a - b);
      if (best === undefined || f < best.f) best = { index: k.index, value: k.value, f };
    }
  }
  return best;
}

/** Start point inside the chord `p -> q`: a closed loop came back to its seed. */
function closes(start: P3, p: P3, q: P3, tol: number): boolean {
  const d = sub3(q, p);
  const l2 = dot3(d, d);
  if (!(l2 > 0)) return false;
  const s = dot3(sub3(start, p), d) / l2;
  if (s < 0 || s > 1) return dist3(start, q) <= tol;
  return dist3(start, madd3(p, d, s)) <= tol;
}

function step(
  problem: Problem,
  x: readonly number[],
  l: Local,
  sign: number,
  h: number,
): { x: number[]; p: P3 } | undefined {
  const t: P3 = sign > 0 ? l.t : [-l.t[0], -l.t[1], -l.t[2]];
  const guess = x.map((xi, i) => xi + sign * h * (l.dxds[i] as number));
  const y = problem.correct(guess, { kind: 'plane', anchor: madd3(l.p, t, h), t });
  return y === undefined ? undefined : { x: y, p: problem.point(y) };
}

/** Last inside point toward an exit between step lengths 0 (inside) and `h` (outside). */
function exitPoint(problem: Problem, x: readonly number[], l: Local, sign: number, h: number) {
  let lo = 0;
  let hi = h;
  let best: { x: number[]; p: P3 } | undefined;
  let outside: number[] | undefined;
  for (let i = 0; i < BISECT && hi - lo > 1e-3 * problem.ptTol; i++) {
    const mid = 0.5 * (lo + hi);
    const s = step(problem, x, l, sign, mid);
    if (s !== undefined && problem.inside(s.x)) {
      lo = mid;
      best = s;
    } else {
      hi = mid;
      if (s !== undefined) outside = s.x;
    }
  }
  const pin = outside === undefined ? undefined : problem.exitPin(outside);
  if (pin !== undefined) {
    const from = best?.x ?? x;
    const guess = [...from];
    guess[pin.index] = pin.value;
    const y = problem.correct(guess, { kind: 'param', index: pin.index, value: pin.value });
    if (
      y !== undefined &&
      problem.inside(y) &&
      dist3(problem.point(y), best?.p ?? l.p) <= 2 * (hi - lo) + 10 * problem.ptTol + 1e-3 * h
    ) {
      return { x: y, p: problem.point(y) };
    }
  }
  return best;
}

function run(
  problem: Problem,
  x0: readonly number[],
  sign: number,
  c: MarchControl,
  start: P3,
): Run & { closed: boolean } {
  const out: Run & { closed: boolean } = {
    xs: [],
    points: [],
    kinks: [],
    end: 'boundary',
    closed: false,
  };
  let x: number[] = [...x0];
  let prev: number[] | undefined;
  let p = problem.point(x);
  let h = c.hMax / 8;
  let travelled = 0;
  const closeTol = 4 * c.sag + 10 * problem.ptTol;
  for (;;) {
    if (c.budget.left <= 0) {
      out.end = 'step-limit';
      return out;
    }
    const l = localAt(problem, x, prev);
    if (l === undefined) {
      out.end = 'singular';
      return out;
    }
    if (l.sin < c.minAngle) {
      out.end = 'near-tangent';
      return out;
    }
    const t: P3 = sign > 0 ? l.t : [-l.t[0], -l.t[1], -l.t[2]];
    let accepted: { x: number[]; p: P3; kink: boolean } | undefined;
    while (accepted === undefined) {
      const s = step(problem, x, l, sign, h);
      if (s === undefined) {
        if (h <= c.hMin) break;
        h = Math.max(c.hMin, 0.5 * h);
        continue;
      }
      if (!problem.inside(s.x)) {
        const e = exitPoint(problem, x, l, sign, h);
        if (e !== undefined && dist3(e.p, p) > problem.ptTol) {
          out.xs.push(e.x);
          out.points.push(e.p);
        }
        out.end = 'boundary';
        return out;
      }
      const chord = dist3(s.p, p);
      const crease = creaseBetween(problem, x, s.x);
      if (crease !== undefined) {
        const guess = x.map((xi, i) => xi + crease.f * ((s.x[i] as number) - xi));
        const y = problem.correct(guess, {
          kind: 'param',
          index: crease.index,
          value: crease.value,
        });
        if (y !== undefined && dist3(problem.point(y), p) <= chord + c.sag) {
          accepted = { x: y, p: problem.point(y), kink: true };
          break;
        }
      }
      const l2 = localAt(problem, s.x, x);
      const theta =
        l2 === undefined ? Math.PI : turn(t, sign > 0 ? l2.t : [-l2.t[0], -l2.t[1], -l2.t[2]]);
      const jump = chord > 1.5 * h || chord < 0.5 * h;
      const sag = (h * theta) / 8;
      if ((jump || sag > c.sag || theta > 0.5) && h > c.hMin) {
        h = Math.max(c.hMin, 0.5 * h);
        continue;
      }
      accepted = { ...s, kink: false };
      if (sag < 0.25 * c.sag && !jump) h = Math.min(c.hMax, GROW * h);
    }
    if (accepted === undefined) {
      out.end = 'singular';
      return out;
    }
    c.budget.left--;
    if (
      travelled > 2 * c.hMin + 3 * problem.ptTol &&
      out.points.length > 2 &&
      closes(start, p, accepted.p, closeTol)
    ) {
      out.closed = true;
      out.end = 'closed';
      while (
        out.points.length > 2 &&
        dist3(out.points[out.points.length - 1] as P3, start) < 0.25 * h
      ) {
        out.points.pop();
        out.xs.pop();
        if (out.kinks[out.kinks.length - 1] === out.points.length) out.kinks.pop();
      }
      return out;
    }
    travelled += dist3(accepted.p, p);
    prev = x;
    x = accepted.x;
    p = accepted.p;
    if (accepted.kink) out.kinks.push(out.points.length);
    out.xs.push(x);
    out.points.push(p);
  }
}

/** March both ways from a corrected seed; a loop that returns to its seed is closed. */
export function march(problem: Problem, seed: readonly number[], c: MarchControl): Traced {
  const start = problem.point(seed);
  const fwd = run(problem, seed, 1, c, start);
  if (fwd.closed) {
    return {
      xs: [seed, ...fwd.xs],
      points: [start, ...fwd.points],
      closed: true,
      kinks: fwd.kinks.map((i) => i + 1),
      ends: ['closed', 'closed'],
      stops: [],
    };
  }
  const back = run(problem, seed, -1, c, start);
  const nb = back.points.length;
  const stops: P3[] = [];
  if (back.end !== 'boundary') stops.push(back.points[nb - 1] ?? start);
  if (fwd.end !== 'boundary') stops.push(fwd.points[fwd.points.length - 1] ?? start);
  return {
    xs: [...[...back.xs].reverse(), seed, ...fwd.xs],
    points: [...[...back.points].reverse(), start, ...fwd.points],
    closed: false,
    kinks: [...back.kinks.map((i) => nb - 1 - i), ...fwd.kinks.map((i) => nb + 1 + i)],
    ends: [back.end, fwd.end],
    stops,
  };
}
