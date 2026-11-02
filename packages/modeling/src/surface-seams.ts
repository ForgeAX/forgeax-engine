import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import type { Region2, Shape2 } from './compute/region-ts';
import { hypot2 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { dot, length, sub, type Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import { curveDerivatives, type NurbsCurve, surfaceDerivatives, surfacePoint } from './nurbs';
import type { PatchSide } from './nurbs-surface';
import type { Point2 } from './primitives';
import { region2d } from './region2d';
import type { Patch } from './surface';
import type { SurfaceSeam } from './surface-quality';

/**
 * The seams of one `m.surface` call (edge-first tessellation): the single owner of how
 * its patches join. Shared sides are found geometrically (and declared by a patch layout);
 * the patch emitted first owns each seam and samples it once, from both sides' isoparm
 * demand; the other patch emits the owner's points with the owner's vertex ids, and its own
 * evaluation there is the seam's measured gap. A positional weld remains only within one
 * patch and for coincidences no seam pairs, capped at the model tolerance.
 *
 * A transition patch's side that runs along another patch's trim outline (a blend's contact
 * side on the face it trims, a corner quad's side on the face's corner square) is a trim seam:
 * the face's isoparm crossings of the outline pin the band's isoparms along that side, the
 * band samples the seam once, and the face's outline takes those points (at the pinned
 * crossings exactly), emitting them with the band's vertex ids.
 */

type Side = 's0' | 's1' | 't0' | 't1';
const SIDES: readonly Side[] = ['s0', 's1', 't0', 't1'];
const PUBLIC_SIDE: Readonly<Record<Side, PatchSide>> = { s0: 'u0', s1: 'u1', t0: 'v0', t1: 'v1' };
const OWN_SIDE: Readonly<Record<PatchSide, Side>> = { u0: 's0', u1: 's1', v0: 't0', v1: 't1' };
/** Two side parameters closer than this are one isoparm. */
const SAME = 1e-9;

export function at(patch: Patch, s: number, t: number): Tuple3 {
  return surfacePoint(
    patch.surface,
    patch.u[0] + s * (patch.u[1] - patch.u[0]),
    patch.v[0] + t * (patch.v[1] - patch.v[0]),
  );
}

/** The domain point of a side parameter. */
function sidePoint(side: Side, x: number): Point2 {
  return side === 's0' ? [0, x] : side === 's1' ? [1, x] : side === 't0' ? [x, 0] : [x, 1];
}

function atClamped(patch: Patch, p: Point2): Tuple3 {
  return at(patch, Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1])));
}

function segmentDistance(p: Tuple3, a: Tuple3, b: Tuple3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  return length(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
}

/** The domain point of patch `face` closest to `q` (Gauss-Newton from `guess`, in the domain). */
function inverse(face: Patch, q: Tuple3, guess: Point2): Point2 {
  const [du, dv] = [face.u[1] - face.u[0], face.v[1] - face.v[0]];
  let [x, y] = guess;
  for (let it = 0; it < 30; it++) {
    const d = surfaceDerivatives(face.surface, face.u[0] + x * du, face.v[0] + y * dv, 1);
    const S = (d[0] as Tuple3[])[0] as Tuple3;
    const su = ((d[1] as Tuple3[])[0] as Tuple3).map((c) => c * du) as unknown as Tuple3;
    const sv = ((d[0] as Tuple3[])[1] as Tuple3).map((c) => c * dv) as unknown as Tuple3;
    const r = sub(q, S);
    const a = dot(su, su);
    const b = dot(su, sv);
    const c = dot(sv, sv);
    const e = dot(su, r);
    const f = dot(sv, r);
    const det = a * c - b * b;
    if (!(Math.abs(det) > 1e-300)) break;
    const nx = Math.min(1, Math.max(0, x + (c * e - b * f) / det));
    const ny = Math.min(1, Math.max(0, y + (a * f - b * e) / det));
    const done = Math.abs(nx - x) + Math.abs(ny - y) < 1e-15;
    [x, y] = [nx, ny];
    if (done) break;
  }
  return [x, y];
}

/** Every side a domain point lies on, with its parameter there (two at a corner). */
export function sidesOf(p: Point2): { side: Side; x: number }[] {
  const e = 1e-12;
  const out: { side: Side; x: number }[] = [];
  if (Math.abs(p[0]) <= e) out.push({ side: 's0', x: p[1] });
  if (Math.abs(p[0] - 1) <= e) out.push({ side: 's1', x: p[1] });
  if (Math.abs(p[1]) <= e) out.push({ side: 't0', x: p[0] });
  if (Math.abs(p[1] - 1) <= e) out.push({ side: 't1', x: p[0] });
  return out;
}

function listOf(patch: Patch, side: Side): number[] {
  return side === 's0' || side === 's1' ? patch.t : patch.s;
}

function setList(patch: Patch, side: Side, list: number[]): void {
  if (side === 's0' || side === 's1') patch.t = list;
  else patch.s = list;
}

function nearest(list: readonly number[], x: number): number {
  for (let k = 0; k < list.length; k++) if (Math.abs((list[k] as number) - x) <= SAME) return k;
  return -1;
}

// ---- boundaries ------------------------------------------------------------------------

function boundaryCurve(patch: Patch, side: Side): NurbsCurve {
  const s = patch.surface;
  const pick = <T>(rows: readonly (readonly T[])[], which: Side): T[] =>
    which === 's0'
      ? [...(rows[0] as readonly T[])]
      : which === 's1'
        ? [...(rows[rows.length - 1] as readonly T[])]
        : rows.map((r) => r[which === 't0' ? 0 : r.length - 1] as T);
  const alongV = side === 's0' || side === 's1';
  const weights = s.weights === undefined ? undefined : pick(s.weights, side);
  return {
    degree: alongV ? s.degreeV : s.degreeU,
    points: pick(s.points, side),
    knots: alongV ? s.knotsV : s.knotsU,
    ...(weights === undefined ? {} : { weights }),
  };
}

interface Boundary {
  readonly patch: Patch;
  readonly side: Side;
  readonly curve: NurbsCurve;
  readonly range: readonly [number, number];
  readonly samples: Tuple3[];
  readonly min: Tuple3;
  readonly max: Tuple3;
}

function boundaryOf(patch: Patch, side: Side): Boundary {
  const curve = boundaryCurve(patch, side);
  const range = side === 's0' || side === 's1' ? patch.v : patch.u;
  const samples = Array.from(
    { length: 33 },
    (_, k) => curveDerivatives(curve, range[0] + ((range[1] - range[0]) * k) / 32, 0)[0] as Tuple3,
  );
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const p of samples) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, p[k] as number);
      max[k] = Math.max(max[k] as number, p[k] as number);
    }
  }
  return { patch, side, curve, range, samples, min, max };
}

function boundaryPoint(b: Boundary, x: number): Tuple3 {
  return curveDerivatives(b.curve, b.range[0] + x * (b.range[1] - b.range[0]), 0)[0] as Tuple3;
}

/** Normalized parameter of the closest boundary point to `p`, with its distance. */
function closestOn(b: Boundary, p: Tuple3): { x: number; distance: number } {
  let best = 0;
  let bestD = Infinity;
  for (const [k, q] of b.samples.entries()) {
    const d = length(sub(q, p));
    if (d < bestD) {
      bestD = d;
      best = k / 32;
    }
  }
  const hit = newtonOn(b, p, best);
  // A closed curve's first and last samples coincide; its last span is reached only from x = 1.
  const first = b.samples[0] as Tuple3;
  const last = b.samples[b.samples.length - 1] as Tuple3;
  if ((best === 0 || best === 1) && length(sub(first, last)) <= 1e-12 * (1 + length(first))) {
    const other = newtonOn(b, p, 1 - best);
    if (other.distance < hit.distance) return other;
  }
  return hit;
}

function newtonOn(b: Boundary, p: Tuple3, start: number): { x: number; distance: number } {
  let x = start;
  const span = b.range[1] - b.range[0];
  for (let it = 0; it < 30; it++) {
    const [c, d1, d2] = curveDerivatives(b.curve, b.range[0] + x * span, 2) as [
      Tuple3,
      Tuple3,
      Tuple3,
    ];
    const r = sub(c, p);
    const f = dot(d1, r) * span;
    const fp = (dot(d1, d1) + dot(d2, r)) * span * span;
    if (fp <= 0) break;
    const next = Math.max(0, Math.min(1, x - f / fp));
    const done = Math.abs(next - x) < 1e-14;
    x = next;
    if (done) break;
  }
  return { x, distance: length(sub(boundaryPoint(b, x), p)) };
}

function live(b: Boundary, reach: number): boolean {
  return length(sub(b.max, b.min)) > reach;
}

function near(a: Boundary, b: Boundary, reach: number): boolean {
  return [0, 1, 2].every(
    (k) =>
      (a.min[k] as number) <= (b.max[k] as number) + reach &&
      (b.min[k] as number) <= (a.max[k] as number) + reach,
  );
}

/**
 * The part of side `a` that `b` shares within `reach`: its two ends (the ends of either side
 * that lie on the other), with interior samples on `b`. One contiguous overlap per side pair.
 */
function overlap(
  a: Boundary,
  b: Boundary,
  reach: number,
): { range: [number, number]; otherRange: [number, number]; distance: number } | undefined {
  const ends: { x: number; y: number }[] = [];
  let distance = 0;
  const add = (x: number, y: number, exactX: boolean) => {
    const p = boundaryPoint(a, x);
    const same = ends.find((e) => length(sub(boundaryPoint(a, e.x), p)) <= reach);
    if (same === undefined) ends.push({ x, y });
    else if (exactX) same.x = x;
    else same.y = y;
  };
  for (const x of [0, 1]) {
    const hit = closestOn(b, boundaryPoint(a, x));
    if (hit.distance <= reach) {
      add(x, hit.x, true);
      distance = Math.max(distance, hit.distance);
    }
  }
  for (const y of [0, 1]) {
    const hit = closestOn(a, boundaryPoint(b, y));
    if (hit.distance <= reach) {
      add(hit.x, y, false);
      distance = Math.max(distance, hit.distance);
    }
  }
  if (ends.length !== 2) return undefined;
  ends.sort((p, q) => p.x - q.x);
  const [e0, e1] = ends as [{ x: number; y: number }, { x: number; y: number }];
  if (length(sub(boundaryPoint(a, e1.x), boundaryPoint(a, e0.x))) <= reach) return undefined;
  const lo = Math.min(e0.y, e1.y);
  const hi = Math.max(e0.y, e1.y);
  for (const f of [0.25, 0.5, 0.75]) {
    const hit = closestOn(b, boundaryPoint(a, e0.x + (e1.x - e0.x) * f));
    if (hit.distance > reach || hit.x < lo - SAME || hit.x > hi + SAME) return undefined;
    distance = Math.max(distance, hit.distance);
  }
  return { range: [e0.x, e1.x], otherRange: [lo, hi], distance };
}

/**
 * The parts of `range` where `present` holds (`range` itself when it holds throughout): 65
 * probes, each run's ends bisected onto where it stops (a trim's crossing of the side).
 */
function presentRuns(range: [number, number], present: (x: number) => boolean): [number, number][] {
  const n = 64;
  const xs = Array.from({ length: n + 1 }, (_, k) => range[0] + ((range[1] - range[0]) * k) / n);
  const on = xs.map(present);
  if (on.every((x) => x)) return [range];
  const edge = (inside: number, outside: number) => {
    let [a, b] = [inside, outside];
    for (let it = 0; it < 40; it++) {
      const m = (a + b) / 2;
      if (present(m)) a = m;
      else b = m;
    }
    return a;
  };
  const out: [number, number][] = [];
  let k = 0;
  while (k <= n) {
    if (!on[k]) {
      k++;
      continue;
    }
    const start = k;
    while (k + 1 <= n && on[k + 1]) k++;
    const lo = start === 0 ? range[0] : edge(xs[start] as number, xs[start - 1] as number);
    const hi = k === n ? range[1] : edge(xs[k] as number, xs[k + 1] as number);
    if (hi > lo + SAME) out.push([lo, hi]);
    k++;
  }
  return out;
}

// ---- the table --------------------------------------------------------------------------

/** Side parameters inserted where a trim or imprint of another patch meets the seam. */
export type SideSplits = Record<Side, number[]>;

interface Seam {
  readonly owner: number;
  readonly ownerSide: Side;
  readonly other: number;
  readonly otherSide: Side;
  readonly a: Boundary;
  readonly b: Boundary;
  /** The shared part of the owner's side and of the other side (side parameters, ascending). */
  readonly range: readonly [number, number];
  readonly otherRange: readonly [number, number];
  /** The seam sample: owner side parameters, the owner's points there, the other side's parameters. */
  params: number[];
  points: Tuple3[];
  mapped: number[];
  /** The other side's closest parameter to each owner point, where the gap is measured. */
  raw: number[];
  /** The vertex class of each sample (`SeamTable.link`): samples at one patch point share it. */
  cls: number[];
}

/**
 * A trim seam: side `side` of transition patch `band` runs along a ring of trim `trim` of
 * patch `face` (shape `shape`, ring `hole`: -1 the outer one).
 */
interface TrimSeam {
  readonly band: number;
  readonly side: Side;
  readonly bound: Boundary;
  readonly face: number;
  readonly trim: number;
  readonly shape: number;
  readonly hole: number;
  /** The part of the band side along the ring (side parameters). */
  readonly range: readonly [number, number];
  /** Band side parameters pinned to a face isoparm crossing of the outline (its exact domain point). */
  readonly pinned: { x: number; uv: Point2; at: number }[];
  params: number[];
  points: Tuple3[];
  /** The face's domain point of each sample (a pinned crossing, else the closest point). */
  uv: Point2[];
  /** Each sample's distance to the face (the measured gap) and to its face point (the move). */
  gap: number[];
  move: number[];
  cls: number[];
}

/** The ring a trim seam follows. */
function ringOf(trims: readonly (readonly Region2[])[], seam: TrimSeam): readonly Point2[] {
  const shape = ((trims[seam.face] as readonly Region2[])[seam.trim] as Region2)[
    seam.shape
  ] as Shape2;
  return seam.hole < 0 ? shape.outer : ((shape.holes ?? [])[seam.hole] as Point2[]);
}

/**
 * The ring with the part `along` holds (from the ring position nearest `samples[0]` to the one
 * nearest the last sample, in the direction whose middle `along` holds) replaced by `samples`.
 */
function splice(
  ring: readonly Point2[],
  samples: readonly Point2[],
  along: (p: Point2) => boolean,
): { ring: Point2[]; forward: boolean } {
  const n = ring.length;
  const locate = (p: Point2) => {
    let best = { k: 0, w: 0, d: Infinity };
    for (let k = 0; k < n; k++) {
      const a = ring[k] as Point2;
      const b = ring[(k + 1) % n] as Point2;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      const w =
        l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      const d = hypot2(a[0] + dx * w - p[0], a[1] + dy * w - p[1]);
      if (d < best.d) best = { k, w, d };
    }
    return best;
  };
  const s = locate(samples[0] as Point2);
  const e = locate(samples[samples.length - 1] as Point2);
  // Ring vertices strictly between the two positions, walking forward from s to e.
  const between = (from: { k: number; w: number }, to: { k: number; w: number }) => {
    const out: number[] = [];
    if (from.k === to.k && from.w <= to.w) return out;
    for (let m = 1; m <= n; m++) {
      const k = (from.k + m) % n;
      out.push(k);
      if (k === to.k) break;
    }
    return out;
  };
  const fwd = between(s, e);
  const bwd = between(e, s);
  const point = (p: { k: number; w: number }): Point2 => {
    const a = ring[p.k] as Point2;
    const b = ring[(p.k + 1) % n] as Point2;
    return [a[0] + (b[0] - a[0]) * p.w, a[1] + (b[1] - a[1]) * p.w];
  };
  // How much of the path from one position through `list` to the other `along` holds: at the
  // middles of its pieces.
  const holds = (from: { k: number; w: number }, list: number[], to: { k: number; w: number }) => {
    const path = [point(from), ...list.map((k) => ring[k] as Point2), point(to)];
    let yes = 0;
    for (let m = 0; m + 1 < path.length; m++) {
      const a = path[m] as Point2;
      const b = path[m + 1] as Point2;
      if (along([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) yes++;
    }
    return yes / Math.max(1, path.length - 1);
  };
  const forward = holds(s, fwd, e) >= holds(e, bwd, s);
  const drop = new Set(forward ? fwd : bwd);
  const out: Point2[] = [];
  const start = forward ? e : s;
  // Walk the kept part from the far end of the samples back round to their start.
  const kept = forward ? between(e, s) : between(s, e);
  const ordered = forward ? [...samples] : [...samples].reverse();
  pushAll(out, ordered);
  for (const k of kept) if (!drop.has(k)) out.push(ring[k] as Point2);
  void start;
  return { ring: out, forward };
}

/** A seam of either kind: patch sides, or a band side along a trim. */
type Owner = Seam | TrimSeam;

/** A side pair a patch layout declares shared (`LayoutEdge`), by patch index. */
export interface DeclaredSeam {
  readonly a: number;
  readonly sideA: PatchSide;
  readonly b: number;
  readonly sideB: PatchSide;
}

export class SeamTable {
  private readonly touching = new Map<string, { seam: Seam; owner: boolean }[]>();

  private readonly patches: readonly Patch[];
  private readonly seams: readonly Seam[];
  /** How far a seam sample may pair with a nearby isoparm of a side: the finder's reach. */
  private readonly slide: number;

  private constructor(patches: readonly Patch[], seams: readonly Seam[], slide: number) {
    this.patches = patches;
    this.seams = seams;
    this.slide = slide;
    for (const seam of seams) {
      for (const [patch, side, owner] of [
        [seam.owner, seam.ownerSide, true],
        [seam.other, seam.otherSide, false],
      ] as const) {
        const key = `${patch}:${side}`;
        const list = this.touching.get(key) ?? [];
        list.push({ seam, owner });
        this.touching.set(key, list);
      }
    }
  }

  /**
   * The seam finder: side pairs (layout-declared ones and any others) whose sides share a part
   * within `reach`. A side part joins one partner, the closest: a thin band between two
   * patches pairs each with the band, not with each other. The lower patch index owns the
   * seam (the lower side for a patch's own closed seam).
   */
  static find(
    patches: readonly Patch[],
    reach: number,
    declared: readonly DeclaredSeam[] = [],
    /** Each patch's trims: a side part inside them is not there and shares nothing. */
    trims: readonly (readonly Region2[])[] = [],
  ): SeamTable {
    const present = (patch: number, side: Side, x: number) =>
      !(trims[patch] ?? []).some((r) => region2d.contains(r, sidePoint(side, x)));
    const bounds = patches.map((p) => SIDES.map((side) => boundaryOf(p, side)));
    const found: { seam: Seam; distance: number }[] = [];
    const seen = new Set<string>();
    const tryPair = (i: number, si: number, j: number, sj: number) => {
      if (i > j || (i === j && si > sj)) [i, si, j, sj] = [j, sj, i, si];
      const key = `${i}:${si}|${j}:${sj}`;
      if ((i === j && si === sj) || seen.has(key)) return;
      // A band narrower than the reach is not closed on itself.
      if (i === j && patches[i]?.spec.transition !== undefined) return;
      seen.add(key);
      const a = (bounds[i] as Boundary[])[si] as Boundary;
      const b = (bounds[j] as Boundary[])[sj] as Boundary;
      if (!live(a, reach) || !live(b, reach) || !near(a, b, reach)) return;
      const shared = overlap(a, b, reach);
      if (shared === undefined) return;
      const ranges = presentRuns(shared.range, (x) => {
        if (!present(i, SIDES[si] as Side, x)) return false;
        return present(j, SIDES[sj] as Side, closestOn(b, boundaryPoint(a, x)).x);
      });
      for (const range of ranges) {
        const ys = range.map((x) => closestOn(b, boundaryPoint(a, x)).x);
        const seam: Seam = {
          owner: i,
          ownerSide: SIDES[si] as Side,
          other: j,
          otherSide: SIDES[sj] as Side,
          a,
          b,
          range,
          otherRange: range === shared.range ? shared.otherRange : [minOf(ys), maxOf(ys)],
          params: [],
          points: [],
          mapped: [],
          raw: [],
          cls: [],
        };
        found.push({ seam, distance: shared.distance });
      }
    };
    for (const d of declared) {
      const si = SIDES.indexOf(OWN_SIDE[d.sideA]);
      const sj = SIDES.indexOf(OWN_SIDE[d.sideB]);
      if (patches[d.a] !== undefined && patches[d.b] !== undefined && si >= 0 && sj >= 0)
        tryPair(d.a, si, d.b, sj);
    }
    for (let i = 0; i < patches.length; i++)
      for (let si = 0; si < 4; si++)
        for (let j = i; j < patches.length; j++)
          for (let sj = j === i ? si + 1 : 0; sj < 4; sj++) tryPair(i, si, j, sj);
    const claims = new Map<string, (readonly [number, number])[]>();
    const free = (patch: number, side: Side, r: readonly [number, number]) =>
      (claims.get(`${patch}:${side}`) ?? []).every(
        (c) => Math.max(c[0], r[0]) >= Math.min(c[1], r[1]) - 1e-6,
      );
    const claim = (patch: number, side: Side, r: readonly [number, number]) =>
      claims.set(`${patch}:${side}`, [...(claims.get(`${patch}:${side}`) ?? []), r]);
    const seams: Seam[] = [];
    for (const { seam } of found.sort((p, q) => p.distance - q.distance)) {
      if (!free(seam.owner, seam.ownerSide, seam.range)) continue;
      if (!free(seam.other, seam.otherSide, seam.otherRange)) continue;
      claim(seam.owner, seam.ownerSide, seam.range);
      claim(seam.other, seam.otherSide, seam.otherRange);
      seams.push(seam);
    }
    seams.sort(
      (p, q) =>
        p.owner - q.owner ||
        SIDES.indexOf(p.ownerSide) - SIDES.indexOf(q.ownerSide) ||
        p.other - q.other ||
        SIDES.indexOf(p.otherSide) - SIDES.indexOf(q.otherSide),
    );
    return new SeamTable(patches, seams, reach);
  }

  private toOther(seam: Seam, x: number): number {
    return closestOn(seam.b, boundaryPoint(seam.a, x)).x;
  }

  private toOwner(seam: Seam, y: number): number {
    return closestOn(seam.a, boundaryPoint(seam.b, y)).x;
  }

  private patch(index: number): Patch {
    return this.patches[index] as Patch;
  }

  /**
   * Even spacing: from each patch not reached yet, every neighbour reached through a whole
   * shared side takes that side's isoparms (breadth first), so a chain of panels and blends
   * meets vertex to vertex instead of each side inserting the other's isoparms as thin strips.
   */
  adopt(): void {
    const whole = (r: readonly [number, number]) => r[0] <= SAME && r[1] >= 1 - SAME;
    const reached = new Set<number>();
    for (let root = 0; root < this.patches.length; root++) {
      if (reached.has(root)) continue;
      reached.add(root);
      const queue = [root];
      while (queue.length > 0) {
        const i = queue.shift() as number;
        for (const side of SIDES)
          for (const { seam, owner } of this.touching.get(`${i}:${side}`) ?? []) {
            const to = owner ? seam.other : seam.owner;
            if (reached.has(to) || !whole(seam.range) || !whole(seam.otherRange)) continue;
            const from = owner ? seam.ownerSide : seam.otherSide;
            const target = owner ? seam.b : seam.a;
            const ends = [boundaryPoint(target, 0), boundaryPoint(target, 1)];
            // The mapped ends of a side that stops just short of its neighbour's are the ends.
            const mapped = listOf(this.patch(i), from)
              .map((x) => (owner ? this.toOther(seam, x) : this.toOwner(seam, x)))
              .filter((y) => {
                const q = boundaryPoint(target, y);
                return ends.every((e) => length(sub(e, q)) > this.slide);
              });
            setList(
              this.patch(to),
              target.side,
              [...new Set([0, 1, ...mapped])].sort((p, q) => p - q),
            );
            reached.add(to);
            queue.push(to);
          }
      }
    }
  }

  /**
   * Both sides' demand: each seam's owner side takes the other side's isoparms in the shared
   * range (mapped by closest point), and the other side every owner isoparm there, until no
   * list changes (a list serves two opposite sides, so one seam's isoparms reach the next).
   * A demanded point within the reach (`snap`) of an isoparm of the side (the nearest one per isoparm)
   * pairs with it instead: within one patch that is cell cleanup, not a sliver strip.
   */
  refine(): void {
    const merge = (b: Boundary, xs: readonly number[]) => {
      const list = listOf(b.patch, b.side);
      const points = list.map((x) => boundaryPoint(b, x));
      const near: { x: number; k: number; d: number }[] = [];
      for (const x of xs) {
        if (nearest(list, x) >= 0) continue;
        const q = boundaryPoint(b, x);
        let k = -1;
        let d = Infinity;
        for (const [j, p] of points.entries()) {
          const e = length(sub(p, q));
          if (e < d) [k, d] = [j, e];
        }
        near.push({ x, k, d });
      }
      const closest = new Map<number, number>();
      for (const n of near)
        if (n.d <= this.slide && n.d < (closest.get(n.k) ?? Infinity)) closest.set(n.k, n.d);
      const added: number[] = [];
      for (const n of near)
        if (closest.get(n.k) !== n.d && nearest(added, n.x) < 0)
          added.push(Math.max(0, Math.min(1, n.x)));
      if (added.length > 0)
        setList(
          b.patch,
          b.side,
          [...list, ...added].sort((p, q) => p - q),
        );
      return added.length > 0;
    };
    for (let round = 0; round < 8; round++) {
      let changed = false;
      for (const seam of this.seams) {
        const [x0, x1] = seam.range;
        const [y0, y1] = seam.otherRange;
        const demand = listOf(this.patch(seam.other), seam.otherSide)
          .filter((y) => y >= y0 - SAME && y <= y1 + SAME)
          .map((y) => this.toOwner(seam, y))
          .filter((x) => x >= x0 - SAME && x <= x1 + SAME);
        if (merge(seam.a, demand)) changed = true;
        const owned = listOf(this.patch(seam.owner), seam.ownerSide)
          .filter((x) => x >= x0 - SAME && x <= x1 + SAME)
          .map((x) => this.toOther(seam, x));
        if (merge(seam.b, owned)) changed = true;
      }
      if (!changed) return;
    }
  }

  /**
   * Record each seam's sample from the final isoparm lists: the owner's parameters and points,
   * each paired with the nearest isoparm of the other side within the reach (closest pairs first,
   * one each). A sample left unpaired (lists that did not settle) joins only positionally.
   */
  sample(): void {
    for (const seam of this.seams) {
      const owner = this.patch(seam.owner);
      const [x0, x1] = seam.range;
      const [y0, y1] = seam.otherRange;
      seam.params = listOf(owner, seam.ownerSide).filter((x) => x >= x0 - SAME && x <= x1 + SAME);
      seam.points = seam.params.map((x) => {
        const p = sidePoint(seam.ownerSide, x);
        return at(owner, p[0], p[1]);
      });
      seam.raw = seam.params.map((x) => this.toOther(seam, x));
      const other = listOf(this.patch(seam.other), seam.otherSide).filter(
        (y) => y >= y0 - SAME && y <= y1 + SAME,
      );
      const targets = other.map((y) => boundaryPoint(seam.b, y));
      const pairs: { k: number; j: number; d: number }[] = [];
      for (const [k, y] of seam.raw.entries()) {
        const q = boundaryPoint(seam.b, y);
        for (const [j, r] of targets.entries()) {
          const d = length(sub(r, q));
          if (d <= this.slide) pairs.push({ k, j, d });
        }
      }
      pairs.sort((p, q) => p.d - q.d || p.k - q.k || p.j - q.j);
      seam.mapped = seam.params.map(() => Number.NaN);
      const used = new Set<number>();
      for (const { k, j } of pairs) {
        if (!Number.isNaN(seam.mapped[k] as number) || used.has(j)) continue;
        seam.mapped[k] = other[j] as number;
        used.add(j);
      }
      seam.cls = seam.params.map(() => -1);
    }
  }

  private insert(seam: Seam, x: number, y: number): void {
    let k = 0;
    while (k < seam.params.length && (seam.params[k] as number) < x) k++;
    const p = sidePoint(seam.ownerSide, x);
    seam.params.splice(k, 0, x);
    seam.points.splice(k, 0, at(this.patch(seam.owner), p[0], p[1]));
    seam.mapped.splice(k, 0, y);
    seam.raw.splice(k, 0, y);
    seam.cls.splice(k, 0, -1);
  }

  /**
   * Trim and imprint crossings of a patch side are points the isoparm lists lack. On a seam
   * each becomes a sample of it, and the partner's side splits there; on a side no seam pairs
   * the crossing is mapped onto every boundary within `reach` (the positional fallback, kept
   * for trim edges crossing undeclared sides). Returns how many such crossings lie within the
   * chord of another boundary but off it (seam cracks).
   */
  crossings(
    cuts: readonly { readonly pieces: readonly { readonly loop: readonly Point2[] }[] }[],
    splits: readonly SideSplits[],
    reach: number,
    chord: number,
  ): number {
    const boundaries = this.patches.flatMap((p) => SIDES.map((side) => boundaryOf(p, side)));
    const alive = boundaries.filter((b) => live(b, reach));
    const index = new Map(this.patches.map((p, i) => [p, i]));
    const split = (patch: number, side: Side, x: number) => {
      const target = (splits[patch] as SideSplits)[side];
      if (nearest(listOf(this.patch(patch), side), x) < 0 && nearest(target, x) < 0) target.push(x);
    };
    let off = 0;
    for (const [i, patch] of this.patches.entries()) {
      const seen = new Set<string>();
      for (const piece of (cuts[i] as (typeof cuts)[number]).pieces) {
        for (const p of piece.loop) {
          for (const on of sidesOf(p)) {
            if (nearest(listOf(patch, on.side), on.x) >= 0 || seen.has(`${on.side}:${on.x}`))
              continue;
            seen.add(`${on.side}:${on.x}`);
            let paired = false;
            for (const { seam, owner } of this.touching.get(`${i}:${on.side}`) ?? []) {
              const [lo, hi] = owner ? seam.range : seam.otherRange;
              if (on.x < lo - SAME || on.x > hi + SAME) continue;
              paired = true;
              const list = owner ? seam.params : seam.mapped;
              if (nearest(list, on.x) >= 0) continue;
              if (owner) {
                const y = this.toOther(seam, on.x);
                this.insert(seam, on.x, y);
                split(seam.other, seam.otherSide, y);
              } else {
                const x = this.toOwner(seam, on.x);
                this.insert(seam, x, on.x);
                split(seam.owner, seam.ownerSide, x);
              }
            }
            if (paired) continue;
            const q = at(patch, p[0], p[1]);
            for (const b of alive) {
              if (b.patch === patch && b.side === on.side) continue;
              if (
                [0, 1, 2].some(
                  (k) =>
                    (q[k] as number) < (b.min[k] as number) - chord ||
                    (q[k] as number) > (b.max[k] as number) + chord,
                )
              )
                continue;
              const hit = closestOn(b, q);
              if (hit.distance > reach) {
                if (hit.distance <= chord && hit.x > SAME && hit.x < 1 - SAME) off++;
                continue;
              }
              if (hit.x <= SAME || hit.x >= 1 - SAME) continue;
              split(index.get(b.patch) as number, b.side, hit.x);
            }
          }
        }
      }
    }
    return off;
  }

  private readonly trimSeams: TrimSeam[] = [];
  /** Trim seam samples by face domain point (`face:s,t`). */
  private readonly trimAt = new Map<string, { seam: TrimSeam; k: number }>();
  /** The same by face, for points the cut recomputes (another trim's crossing), within 1e-9. */
  private readonly trimNear = new Map<number, { uv: Point2; seam: TrimSeam; k: number }[]>();

  /** Whether domain point `p` of patch `face` is in its domain and outside its trims but `trim`. */
  private presentOn(
    trims: readonly (readonly Region2[])[],
    face: number,
    trim: number,
    p: Point2,
  ): boolean {
    if (!p.every((c) => c >= 0 && c <= 1)) return false;
    return !(trims[face] ?? []).some((r, k) => k !== trim && region2d.contains(r, p));
  }

  /**
   * The trim seam finder. A transition patch's side that no side seam pairs is a trim seam
   * over each part that runs along one trim ring of an ordinary patch: within `tol` of the
   * ring (the chord: its refined sag), on the patch's surface (within `onFace`) and outside
   * its other trims, at 65 probes, the closest ring at each (a blend's v sides only).
   */
  findTrims(trims: readonly (readonly Region2[])[], tol: number, onFace: number): void {
    const images = new Map<string, Tuple3[]>();
    const imageOf = (j: number, r: number, sh: number, h: number, ring: readonly Point2[]) => {
      const key = `${j}:${r}:${sh}:${h}`;
      let image = images.get(key);
      if (image === undefined) {
        image = ring.map((p) => atClamped(this.patch(j), p));
        images.set(key, image);
      }
      return image;
    };
    const n = 64;
    for (const [i, band] of this.patches.entries()) {
      if (band.spec.transition === undefined) continue;
      // A blend's contact sides are its v sides (u runs along the edge).
      const sides: readonly Side[] = band.spec.transition.kind === 'blend' ? ['t0', 't1'] : SIDES;
      for (const side of sides) {
        // The parts a side seam claims (a corner quad's side along a blend end) are not trim seams.
        const claimed = (this.touching.get(`${i}:${side}`) ?? []).map(({ seam, owner }) =>
          owner ? seam.range : seam.otherRange,
        );
        const bound = boundaryOf(band, side);
        if (!live(bound, this.slide)) continue;
        // A blend's fit stands within ten times its fit tolerance of its trims (`check`).
        const lies = Math.max(onFace, 20 * (band.spec.transition?.gap ?? 0));
        // The best ring at each probe, and whether another face's ring lies within the fit there too.
        const at01 = Array.from({ length: n + 1 }, (_, k) => k / n);
        const probes = at01.map((x) => {
          if (claimed.some(([lo, hi]) => x > lo + SAME && x < hi - SAME)) return undefined;
          const q = boundaryPoint(bound, x);
          // The best ring on each face.
          const byFace = new Map<
            number,
            { face: number; trim: number; shape: number; hole: number; d: number }
          >();
          for (const [j, face] of this.patches.entries()) {
            if (j === i || face.spec.transition !== undefined) continue;
            for (const [r, region] of (trims[j] ?? []).entries()) {
              for (const [sh, shape] of region.entries())
                for (const [h, ring] of [shape.outer, ...(shape.holes ?? [])].entries()) {
                  const image = imageOf(j, r, sh, h, ring);
                  let d = Infinity;
                  let near = 0;
                  for (let k = 0; k < image.length; k++) {
                    const e = segmentDistance(
                      q,
                      image[k] as Tuple3,
                      image[(k + 1) % image.length] as Tuple3,
                    );
                    if (e < d) [d, near] = [e, k];
                  }
                  if (!(d <= tol) || d >= (byFace.get(j)?.d ?? Infinity)) continue;
                  const g = ring[near] as Point2;
                  const own = inverse(face, q, [
                    Math.min(1, Math.max(0, g[0])),
                    Math.min(1, Math.max(0, g[1])),
                  ]);
                  if (!(length(sub(at(face, own[0], own[1]), q)) <= lies)) continue;
                  if (!this.presentOn(trims, j, r, own)) continue;
                  byFace.set(j, { face: j, trim: r, shape: sh, hole: h - 1, d });
                }
            }
          }
          const [best, second] = [...byFace.values()].sort((a, b) => a.d - b.d);
          return best === undefined
            ? undefined
            : { best, sure: !((second?.d ?? Infinity) <= lies) };
        });
        // Where two rings meet (a run-out's tip, where both contacts reach the crease) both lie
        // within the fit: such a probe takes the ring of its nearest unambiguous probe.
        const pick = probes.map((p, k) => {
          if (p === undefined || p.sure) return p?.best;
          for (let r = 1; r <= n; r++)
            for (const o of [probes[k - r], probes[k + r]]) if (o?.sure === true) return o.best;
          return p.best;
        });
        // Runs of probes on one ring: one trim seam each (its range reaches the probes beyond,
        // where its pinned crossings settle the exact ends).
        let k = 0;
        while (k <= n) {
          const p = pick[k];
          if (p === undefined) {
            k++;
            continue;
          }
          const start = k;
          const same = (o: typeof p | undefined) =>
            o !== undefined &&
            o.face === p.face &&
            o.trim === p.trim &&
            o.shape === p.shape &&
            o.hole === p.hole;
          while (k + 1 <= n && same(pick[k + 1])) k++;
          if (k > start)
            this.trimSeams.push({
              band: i,
              side,
              bound,
              face: p.face,
              trim: p.trim,
              shape: p.shape,
              hole: p.hole,
              range: [Math.max(0, (start - 1) / n), Math.min(1, (k + 1) / n)],
              pinned: [],
              params: [],
              points: [],
              uv: [],
              gap: [],
              move: [],
              cls: [],
            });
          k++;
        }
      }
    }
  }

  /** Whether trim `trim` of patch `face` carries a trim seam (it takes no trim ring). */
  hostsTrimSeam(face: number, trim: number): boolean {
    return this.trimSeams.some((t) => t.face === face && t.trim === trim);
  }

  /**
   * The seam traced on the face: the band side at 129 probes over its range, each mapped onto
   * the face (closest point, continued from the last), with its band parameter.
   */
  private trace(
    trims: readonly (readonly Region2[])[],
    seam: TrimSeam,
  ): { x: number; uv: Point2 }[] {
    const face = this.patch(seam.face);
    const ring = ringOf(trims, seam);
    const [lo, hi] = seam.range;
    const n = 128;
    const out: { x: number; uv: Point2 }[] = [];
    let guess: Point2 | undefined;
    for (let k = 0; k <= n; k++) {
      const x = lo + ((hi - lo) * k) / n;
      const q = boundaryPoint(seam.bound, x);
      if (guess === undefined) {
        let best = ring[0] as Point2;
        let d = Infinity;
        for (const p of ring) {
          const e = length(sub(atClamped(face, p), q));
          if (e < d) [best, d] = [p, e];
        }
        guess = [Math.min(1, Math.max(0, best[0])), Math.min(1, Math.max(0, best[1]))];
      }
      const uv = inverse(face, q, guess);
      out.push({ x, uv });
      guess = uv;
    }
    return out;
  }

  /**
   * The points the face's cut makes on the traced seam: its crossings of the face's isoparms
   * where the face keeps the outline, and of the face's other trims (where they cut the seam
   * off); exact domain points, with their band parameters, in band order.
   */
  private crossingsOf(
    trims: readonly (readonly Region2[])[],
    seam: TrimSeam,
    path: readonly { x: number; uv: Point2 }[],
  ): { p: Point2; x: number; edge: boolean }[] {
    const face = this.patch(seam.face);
    const out: { p: Point2; x: number; edge: boolean }[] = [];
    const inner = (x: number) => x > SAME && x < 1 - SAME;
    const others: Point2[][] = [];
    for (const [r, region] of (trims[seam.face] ?? []).entries())
      if (r !== seam.trim)
        for (const shape of region)
          for (const other of [shape.outer, ...(shape.holes ?? [])]) others.push([...other]);
    const exact = (p: Point2) => closestOn(seam.bound, at(face, p[0], p[1])).x;
    for (let m = 0; m + 1 < path.length; m++) {
      const a = (path[m] as { uv: Point2 }).uv;
      const b = (path[m + 1] as { uv: Point2 }).uv;
      const found: { w: number; p: Point2; edge: boolean }[] = [];
      for (const axis of [0, 1] as const) {
        const list = axis === 0 ? face.s : face.t;
        const [pa, pb] = [a[axis], b[axis]];
        if (pa === pb) continue;
        for (const x of list) {
          if (!inner(x) || (x - pa) * (x - pb) > 0 || x === pb) continue;
          const w = (x - pa) / (pb - pa);
          const o = axis === 0 ? 1 : 0;
          const y = a[o] + (b[o] - a[o]) * w;
          if (y < 0 || y > 1) continue;
          found.push({ w, p: axis === 0 ? [x, y] : [y, x], edge: false });
        }
      }
      for (const other of others)
        for (let e = 0; e < other.length; e++) {
          const c = other[e] as Point2;
          const d = other[(e + 1) % other.length] as Point2;
          const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
          if (den === 0) continue;
          const w = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
          const v = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
          if (w < 0 || w >= 1 || v < 0 || v > 1) continue;
          const p: Point2 = [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
          if (p.every((c) => c >= 0 && c <= 1)) found.push({ w, p, edge: true });
        }
      found.sort((p, q) => p.w - q.w);
      for (const f of found)
        if (f.edge || this.presentOn(trims, seam.face, seam.trim, f.p))
          out.push({ ...f, x: exact(f.p) });
    }
    return out;
  }

  /**
   * Pin the band isoparms along each trim seam to the points the face's cut makes on it
   * (`crossingsOf`): each pairs with the band isoparm within the reach (or 0.3 of its spacing:
   * the other face's grid mapped onto the band a hair apart would leave a sliver column) that
   * no point holds yet, else inserts one; another trim's cut always inserts. On the first round
   * a band's own isoparms along the seams give way (the caller refines the band to the chord
   * again). Returns whether a list changed.
   */
  demandTrims(trims: readonly (readonly Region2[])[], first: boolean): boolean {
    let changed = false;
    if (first)
      for (const seam of this.trimSeams) {
        const band = this.patch(seam.band);
        const [lo, hi] = seam.range;
        setList(
          band,
          seam.side,
          listOf(band, seam.side).filter((x) => x === 0 || x === 1 || x < lo || x > hi),
        );
        changed = true;
      }
    for (const seam of this.trimSeams) {
      const band = this.patch(seam.band);
      const points = this.crossingsOf(trims, seam, this.trace(trims, seam));
      const face = this.patch(seam.face);
      const image = points.map(({ p }) => at(face, p[0], p[1]));
      for (const [m, { p: c, x, edge }] of points.entries()) {
        if (seam.pinned.some((p) => p.uv[0] === c[0] && p.uv[1] === c[1])) continue;
        const list = listOf(band, seam.side);
        const here = boundaryPoint(seam.bound, x);
        // Within the reach, or within 0.3 of this face's own spacing of its points there: the
        // other face's grid mapped onto the band a hair apart would leave sliver cells here.
        const spacing = Math.min(
          ...[image[m - 1], image[m + 1]].flatMap((q) =>
            q === undefined ? [] : [length(sub(q, image[m] as Tuple3))],
          ),
        );
        let k = -1;
        let d = Infinity;
        for (const [j, y] of list.entries()) {
          if (edge || seam.pinned.some((p) => p.x === y)) continue;
          const reach = y === 0 || y === 1 ? this.slide : Math.max(this.slide, 0.3 * spacing);
          const e = length(sub(boundaryPoint(seam.bound, y), here));
          if (e <= reach && e < d) [k, d] = [j, e];
        }
        if (k >= 0) seam.pinned.push({ x: list[k] as number, uv: c, at: x });
        else {
          setList(
            band,
            seam.side,
            [...list, x].sort((p, r) => p - r),
          );
          seam.pinned.push({ x, uv: c, at: x });
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * Sample each trim seam from the final band lists (points of the face's cut left unpinned
   * become side splits of the band) and return every patch's trims with each seam's part of
   * its ring replaced by the samples' face points.
   */
  sampleTrims(
    trims: readonly (readonly Region2[])[],
    splits: readonly SideSplits[],
    tol: number,
  ): Region2[][] {
    const rings = new Map<string, Point2[]>();
    const keyOf = (seam: TrimSeam) => `${seam.face}:${seam.trim}:${seam.shape}:${seam.hole + 1}`;
    for (const seam of this.trimSeams) {
      const band = this.patch(seam.band);
      const face = this.patch(seam.face);
      const path = this.trace(trims, seam);
      for (const { p: c, x } of this.crossingsOf(trims, seam, path)) {
        if (seam.pinned.some((p) => p.uv[0] === c[0] && p.uv[1] === c[1])) continue;
        seam.pinned.push({ x, uv: c, at: x });
        const target = (splits[seam.band] as SideSplits)[seam.side];
        if (nearest(listOf(band, seam.side), x) < 0 && nearest(target, x) < 0) target.push(x);
      }
      // A pin whose isoparm another isoparm since passes (between the crossing and it) would
      // fold the outline: the crossing takes a side split of its own there instead.
      const list = listOf(band, seam.side);
      for (const [j, p] of seam.pinned.entries()) {
        const [a, b] = [Math.min(p.x, p.at), Math.max(p.x, p.at)];
        if (!list.some((z) => z !== p.x && z > a && z < b)) continue;
        seam.pinned[j] = { x: p.at, uv: p.uv, at: p.at };
        const target = (splits[seam.band] as SideSplits)[seam.side];
        if (nearest(list, p.at) < 0 && nearest(target, p.at) < 0) target.push(p.at);
      }
      const [lo, hi] = seam.range;
      const candidates = [
        ...new Set([...listOf(band, seam.side), ...(splits[seam.band] as SideSplits)[seam.side]]),
      ]
        .filter((x) => x >= lo - SAME && x <= hi + SAME)
        .sort((p, q) => p - q);
      const guessAt = (x: number): Point2 => {
        let best = (path[0] as { uv: Point2 }).uv;
        let d = Infinity;
        for (const p of path) if (Math.abs(p.x - x) < d) [best, d] = [p.uv, Math.abs(p.x - x)];
        return best;
      };
      seam.params = [];
      seam.points = [];
      seam.uv = [];
      seam.gap = [];
      seam.move = [];
      for (const x of candidates) {
        const sp = sidePoint(seam.side, x);
        const q = at(band, sp[0], sp[1]);
        const own = inverse(face, q, guessAt(x)).map((c) =>
          Math.abs(c) <= 1e-9 ? 0 : Math.abs(c - 1) <= 1e-9 ? 1 : c,
        ) as unknown as Point2;
        const pin = seam.pinned.find((p) => p.x === x);
        const gap = length(sub(at(face, own[0], own[1]), q));
        // Only where the face keeps the outline: its other trims cut the seam off.
        if (pin === undefined && (gap > tol || !this.presentOn(trims, seam.face, seam.trim, own)))
          continue;
        const uv = pin?.uv ?? own;
        seam.params.push(x);
        seam.points.push(q);
        seam.uv.push(uv);
        seam.gap.push(gap);
      }
      seam.cls = seam.params.map(() => -1);
      if (seam.uv.length < 2) continue;
      // Splice the samples into the ring in place of the part they follow.
      const key = keyOf(seam);
      const ring = rings.get(key) ?? [...ringOf(trims, seam)];
      const spliced = splice(ring, seam.uv, (p) => {
        // A blend's strip closes outside the domain: only the outline inside follows the band.
        if (!p.every((c) => c >= 0 && c <= 1)) return false;
        const hit = closestOn(seam.bound, atClamped(face, p));
        return hit.distance <= tol && hit.x >= lo - SAME && hit.x <= hi + SAME;
      });
      // A seam end within the chord of where the ring leaves the domain (a blend held a hair
      // inside its slanted end) moves onto that side point: the face keeps no sliver there.
      for (const end of [0, seam.uv.length - 1]) {
        const p = seam.uv[end] as Point2;
        if (p.some((c) => c === 0 || c === 1)) continue;
        const dir = (end === 0) === spliced.forward ? -1 : 1;
        const ring = spliced.ring;
        for (let guard = 0; guard < ring.length; guard++) {
          const at0 = ring.indexOf(seam.uv[end] as Point2);
          const next = ring[(at0 + dir + ring.length) % ring.length] as Point2;
          const q = seam.points[end] as Tuple3;
          if (next.every((c) => c >= 0 && c <= 1)) {
            const near = length(sub(at(face, next[0], next[1]), q));
            // The ring's own point on a side there (the contact's end): the seam end takes it.
            if (next.some((c) => c === 0 || c === 1) && near <= tol) {
              ring.splice(ring.indexOf(next), 1);
              ring[ring.indexOf(seam.uv[end] as Point2)] = next;
              seam.uv[end] = next;
              break;
            }
            // A ring point within the reach of the end would leave a needle.
            if (near <= this.slide) {
              ring.splice(ring.indexOf(next), 1);
              continue;
            }
            break;
          }
          // Where the ring leaves the domain within the chord (a blend held a hair inside its
          // slanted end), the end moves onto that side point: the face keeps no sliver there.
          const from = seam.uv[end] as Point2;
          let w = 1;
          for (const c of [0, 1] as const) {
            if (next[c] < 0) w = Math.min(w, from[c] / (from[c] - next[c]));
            if (next[c] > 1) w = Math.min(w, (1 - from[c]) / (next[c] - from[c]));
          }
          const e = [from[0] + (next[0] - from[0]) * w, from[1] + (next[1] - from[1]) * w].map(
            (c) => (Math.abs(c) < 1e-12 ? 0 : Math.abs(c - 1) < 1e-12 ? 1 : c),
          ) as unknown as Point2;
          if (length(sub(at(face, e[0], e[1]), q)) <= tol) {
            ring[at0] = e;
            seam.uv[end] = e;
          }
          break;
        }
      }
      rings.set(key, spliced.ring);
      for (const [k, uv] of seam.uv.entries()) {
        seam.move.push(length(sub(at(face, uv[0], uv[1]), seam.points[k] as Tuple3)));
        this.trimAt.set(`${seam.face}:${uv[0]},${uv[1]}`, { seam, k });
        const list = this.trimNear.get(seam.face) ?? [];
        list.push({ uv, seam, k });
        this.trimNear.set(seam.face, list);
      }
    }
    return trims.map((list, j) =>
      list.map((region, r) =>
        region.map((shape, sh): Shape2 => {
          const outer = rings.get(`${j}:${r}:${sh}:0`) ?? [...shape.outer];
          return shape.holes === undefined
            ? { outer }
            : {
                outer,
                holes: shape.holes.map((h, k) => rings.get(`${j}:${r}:${sh}:${k + 1}`) ?? [...h]),
              };
        }),
      ),
    );
  }

  /** Whether a domain point of patch `face` is a trim seam sample. */
  onTrimSeam(face: number, p: Point2): boolean {
    return this.trimAt.has(`${face}:${p[0]},${p[1]}`);
  }

  private gaps(): { gap: number; at: Tuple3; length: number }[] {
    return this.seams.map((seam) => {
      const other = this.patch(seam.other);
      let gap = 0;
      let where = seam.points[0] ?? ([0, 0, 0] as Tuple3);
      let total = 0;
      for (const [k, point] of seam.points.entries()) {
        if (k > 0) total += length(sub(point, seam.points[k - 1] as Tuple3));
        const p = sidePoint(seam.otherSide, seam.raw[k] as number);
        const d = length(sub(at(other, p[0], p[1]), point));
        if (d > gap) {
          gap = d;
          where = point;
        }
      }
      return { gap, at: where, length: total };
    });
  }

  private trimGaps(): { gap: number; at: Tuple3; length: number }[] {
    return this.trimSeams.map((seam) => {
      let gap = 0;
      let where = seam.points[0] ?? ([0, 0, 0] as Tuple3);
      let total = 0;
      for (const [k, point] of seam.points.entries()) {
        if (k > 0) total += length(sub(point, seam.points[k - 1] as Tuple3));
        if ((seam.gap[k] as number) > gap) [gap, where] = [seam.gap[k] as number, point];
      }
      return { gap, at: where, length: total };
    });
  }

  private trimLabel(names: readonly string[], seam: TrimSeam): string {
    return `${names[seam.band]}:${PUBLIC_SIDE[seam.side]}|${names[seam.face]}:trim${seam.trim}`;
  }

  /**
   * Judge every seam's measured gap: valid within the model tolerance, tolerant (a warning
   * naming it) within twice the tolerance or within the caller's `sew` bound capped at a tenth
   * of the seam length; a larger gap is `model-precondition`.
   */
  check(
    names: readonly string[],
    tolerance: number,
    sew: number | undefined,
  ): Result<{ seam: string; gap: number; at: Tuple3; limit: number }[], ModelingError> {
    const tolerant: { seam: string; gap: number; at: Tuple3; limit: number }[] = [];
    const failing: { seam: string; gap: number; at: Tuple3; limit: number }[] = [];
    const all = [
      ...this.gaps().map((measured, k) => {
        const seam = this.seams[k] as Seam;
        return { measured, seam: label(names, seam), limit: this.limit(seam, tolerance, sew) };
      }),
      ...this.trimGaps().map((measured, k) => {
        const seam = this.trimSeams[k] as TrimSeam;
        return {
          measured,
          seam: this.trimLabel(names, seam),
          limit: this.limit(seam, tolerance, sew),
        };
      }),
    ];
    for (const { measured, seam, limit } of all) {
      const entry = { seam, gap: measured.gap, at: measured.at, limit };
      if (measured.gap > limit) failing.push(entry);
      else if (measured.gap > tolerance) tolerant.push(entry);
    }
    if (failing.length > 0)
      return err(
        modelingError(
          'model-precondition',
          'patch sides found shared meet within the sew tolerance',
          { seams: failing, tolerance, ...(sew === undefined ? {} : { sew }) },
          'match the sides of every listed seam (layout continuity, nurbs.match), or pass sew (m) to sew them as tolerant seams; it is capped at a tenth of the seam length',
        ),
      );
    return ok(tolerant);
  }

  /**
   * A seam's sew limit: twice the tolerance, or `sew` capped at a tenth of the seam length; a
   * trim seam's blend fit stands within ten times its fit tolerance (twice its declared gap) of
   * the trims it follows (`blendSurfaces`), its own bound.
   */
  private limit(seam: Owner, tolerance: number, sew: number | undefined): number {
    let total = 0;
    for (let k = 1; k < seam.points.length; k++)
      total += length(sub(seam.points[k] as Tuple3, seam.points[k - 1] as Tuple3));
    const fit = 'band' in seam ? 20 * (this.patch(seam.band).spec.transition?.gap ?? 0) : 0;
    return Math.max(2 * tolerance, fit, Math.min(sew ?? 0, 0.1 * total));
  }

  /**
   * Blend bands closed at an end (`link`): the band, the side parameter where the collapse starts
   * and the end it runs to, how many vertices it merged and the largest move (the band's width).
   */
  tolerantChains(
    names: readonly string[],
  ): { band: string; from: number; end: number; vertices: number; move: number }[] {
    return this.chains.map((c) => ({
      band: names[c.band] as string,
      from: c.from,
      end: c.end,
      vertices: c.count,
      move: c.move,
    }));
  }

  /** Vertices where seams converge at their ends and merged within the reach (`link`). */
  tolerantVertices(names: readonly string[]): { seams: string[]; move: number; at: Tuple3 }[] {
    return this.converged.map((v) => ({
      seams: [...v.seams].map((x) => ('band' in x ? this.trimLabel(names, x) : label(names, x))),
      move: v.move,
      at: v.at,
    }));
  }

  /**
   * One vertex class per patch point: samples of different seams at one point of a patch (a
   * corner where three or four patches meet, or two seams along one side) become one vertex,
   * at the point of the first-emitted owner among them. Samples of different seams that lie
   * closer on one patch merge only within the sew limit, or within the reach (`snap`) where
   * every sample involved ends its seam: a tip or corner where seams converge (a blend band's
   * end narrower than `snap` closes to a point), recorded as a tolerant vertex. A blend band
   * (transition kind 'blend') closes from where its width drops below the reach to its end, a
   * tolerant vertex chain. Two seams that pass near each other mid-span stay apart. Call after
   * `crossings`.
   */
  link(tolerance: number, sew: number | undefined): void {
    const nodes: { seam: Owner; k: number; at: { patch: number; q: Tuple3 }[] }[] = [];
    const parent: number[] = [];
    const find = (n: number): number => {
      let r = n;
      while (parent[r] !== r) r = parent[r] as number;
      return r;
    };
    const first = new Map<string, number>();
    for (const seam of this.seams)
      for (let k = 0; k < seam.params.length; k++) {
        const n = nodes.length;
        const node = { seam, k, at: [] as { patch: number; q: Tuple3 }[] };
        nodes.push(node);
        parent.push(n);
        for (const [patch, side, x, owner] of [
          [seam.owner, seam.ownerSide, seam.params[k] as number, true],
          [seam.other, seam.otherSide, seam.mapped[k] as number, false],
        ] as const) {
          if (!Number.isFinite(x)) continue;
          const p = sidePoint(side, x);
          node.at.push({
            patch,
            q: owner ? (seam.points[k] as Tuple3) : at(this.patch(patch), p[0], p[1]),
          });
          const key = `${patch}:${p[0]},${p[1]}`;
          const m = first.get(key);
          if (m === undefined) first.set(key, n);
          else {
            const a = find(n);
            const b = find(m);
            if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
          }
        }
      }
    for (const seam of this.trimSeams)
      for (let k = 0; k < seam.params.length; k++) {
        const n = nodes.length;
        const node = { seam: seam as Owner, k, at: [] as { patch: number; q: Tuple3 }[] };
        nodes.push(node);
        parent.push(n);
        const uv = seam.uv[k] as Point2;
        for (const [patch, p, q] of [
          [seam.band, sidePoint(seam.side, seam.params[k] as number), seam.points[k] as Tuple3],
          [seam.face, uv, at(this.patch(seam.face), uv[0], uv[1])],
        ] as const) {
          node.at.push({ patch, q });
          const key = `${patch}:${p[0]},${p[1]}`;
          const m = first.get(key);
          if (m === undefined) first.set(key, n);
          else {
            const a = find(n);
            const b = find(m);
            if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
          }
        }
      }
    // A blend band closes from where its own width (contact to contact) drops below the reach
    // to its end: its two contact sides' samples merge pairwise there, a tolerant vertex chain.
    this.chains.length = 0;
    const base = new Map<Owner, number>();
    for (const [n, node] of nodes.entries()) if (node.k === 0) base.set(node.seam, n);
    const nodeAt = (patch: number, side: Side, x: number): number | undefined => {
      for (const { seam, owner } of this.touching.get(`${patch}:${side}`) ?? []) {
        const k = nearest(owner ? seam.params : seam.mapped, x);
        if (k >= 0) return (base.get(seam) as number) + k;
      }
      // A trim seam's band side (U74: the blend runs along the faces' trims).
      for (const seam of this.trimSeams) {
        if (seam.band !== patch || seam.side !== side) continue;
        const k = nearest(seam.params, x);
        if (k >= 0) return (base.get(seam) as number) + k;
      }
      return undefined;
    };
    for (const [b, band] of this.patches.entries()) {
      if (band.spec.transition?.kind !== 'blend') continue;
      for (const [sa, sb] of [
        ['s0', 's1'],
        ['t0', 't1'],
      ] as const) {
        const joined = (side: Side) =>
          this.touching.has(`${b}:${side}`) ||
          this.trimSeams.some((t) => t.band === b && t.side === side);
        if (!joined(sa) || !joined(sb)) continue;
        const list = listOf(band, sa);
        const width = (x: number) => {
          const p = sidePoint(sa, x);
          const q = sidePoint(sb, x);
          return length(sub(at(band, p[0], p[1]), at(band, q[0], q[1])));
        };
        for (const order of [list, [...list].reverse()]) {
          let count = 0;
          let move = 0;
          let from = order[0] as number;
          for (const x of order) {
            const w = width(x);
            if (!(w < this.slide)) break;
            const na = nodeAt(b, sa, x);
            const nb = nodeAt(b, sb, x);
            if (na === undefined || nb === undefined) break;
            const r = find(na);
            const t = find(nb);
            if (r !== t) parent[Math.max(r, t)] = Math.min(r, t);
            count++;
            move = Math.max(move, w);
            from = x;
          }
          if (count > 0 && move > 0)
            this.chains.push({ band: b, from, end: order[0] as number, count, move });
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (let n = 0; n < nodes.length; n++) {
      const r = find(n);
      groups.set(r, [...(groups.get(r) ?? []), n]);
    }
    // Groups join greedily, as the welder does: the nearest class within reach on a patch they
    // share, never one holding a sample of the same seam (that would fold the seam).
    this.classes.length = 0;
    this.converged.length = 0;
    const seamsOf: Set<Owner>[] = [];
    const ends: boolean[] = [];
    const isEnd = (n: number) => {
      const node = nodes[n] as { seam: Owner; k: number };
      return node.k === 0 || node.k === node.seam.params.length - 1;
    };
    const cap = (a: Set<Owner>, b: Set<Owner>) =>
      minOf([...a, ...b].map((x) => this.limit(x, tolerance, sew)));
    const cells = new Map<string, { c: number; q: Tuple3 }[]>();
    const cellKey = (patch: number, q: Tuple3, d: readonly number[] = [0, 0, 0]) =>
      `${patch}:${q.map((x, k) => Math.floor(x / this.slide) + (d[k] as number)).join(',')}`;
    for (const members of groups.values()) {
      const mine = new Set(members.map((n) => (nodes[n] as { seam: Owner }).seam));
      const end = members.every(isEnd);
      const points = members.flatMap(
        (n) => (nodes[n] as { at: { patch: number; q: Tuple3 }[] }).at,
      );
      let best = -1;
      let bestD = Infinity;
      for (const { patch, q } of points)
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dz = -1; dz <= 1; dz++)
              for (const o of cells.get(cellKey(patch, q, [dx, dy, dz])) ?? []) {
                const d = length(sub(o.q, q));
                const theirs = seamsOf[o.c] as Set<Owner>;
                const reach = end && ends[o.c] === true ? this.slide : cap(mine, theirs);
                if (d <= reach && d < bestD && ![...mine].some((x) => theirs.has(x))) {
                  best = o.c;
                  bestD = d;
                }
              }
      let c = best;
      if (c < 0) {
        // Seams are sorted by owner, so the group's first sample has the first-emitted owner.
        const head = nodes[members[0] as number] as { seam: Owner; k: number };
        c = this.classes.length;
        this.classes.push({ point: head.seam.points[head.k] as Tuple3, id: -1 });
        seamsOf.push(new Set());
        ends.push(end);
      } else {
        ends[c] = ends[c] === true && end;
        const theirs = seamsOf[c] as Set<Owner>;
        if (bestD > cap(mine, theirs)) {
          const at = (this.classes[c] as { point: Tuple3 }).point;
          const v = this.converged.find((x) => x.at === at);
          if (v === undefined)
            this.converged.push({ at, move: bestD, seams: new Set([...theirs, ...mine]) });
          else {
            v.move = Math.max(v.move, bestD);
            for (const x of mine) v.seams.add(x);
          }
        }
      }
      for (const x of mine) seamsOf[c]?.add(x);
      for (const n of members) {
        const node = nodes[n] as { seam: Owner; k: number };
        node.seam.cls[node.k] = c;
      }
      for (const { patch, q } of points) {
        const key = cellKey(patch, q);
        cells.set(key, [...(cells.get(key) ?? []), { c, q }]);
      }
    }
  }

  private readonly classes: { point: Tuple3; id: number }[] = [];
  private readonly converged: { at: Tuple3; move: number; seams: Set<Owner> }[] = [];
  private readonly chains: {
    band: number;
    from: number;
    end: number;
    count: number;
    move: number;
  }[] = [];

  /** The vertex of a domain point of patch `i`: its seam samples' shared vertex, or a positional weld. */
  vertex(i: number, p: Point2, welder: Welder3): number {
    let cls: { point: Tuple3; id: number } | undefined;
    const trim =
      this.trimAt.get(`${i}:${p[0]},${p[1]}`) ??
      this.trimNear
        .get(i)
        ?.find((t) => Math.abs(t.uv[0] - p[0]) + Math.abs(t.uv[1] - p[1]) <= 1e-9);
    if (trim !== undefined) cls = this.classes[trim.seam.cls[trim.k] as number];
    for (const on of sidesOf(p))
      for (const seam of this.trimSeams) {
        if (seam.band !== i || seam.side !== on.side) continue;
        const k = nearest(seam.params, on.x);
        const c = k < 0 ? undefined : this.classes[seam.cls[k] as number];
        if (c !== undefined && (cls === undefined || (cls.id < 0 && c.id >= 0))) cls = c;
      }
    for (const on of sidesOf(p))
      for (const { seam, owner } of this.touching.get(`${i}:${on.side}`) ?? []) {
        const k = nearest(owner ? seam.params : seam.mapped, on.x);
        const c = k < 0 ? undefined : this.classes[seam.cls[k] as number];
        if (c !== undefined && (cls === undefined || (cls.id < 0 && c.id >= 0))) cls = c;
      }
    if (cls === undefined) return welder.id(at(this.patch(i), p[0], p[1]), i);
    // A seam vertex joins another positionally only as a coincidence (the cap), never by snap.
    if (cls.id < 0) cls.id = welder.id(cls.point, i, true);
    else welder.use(cls.id, i);
    return cls.id;
  }

  report(names: readonly string[], welder: Welder3): { owner: number; seam: SurfaceSeam }[] {
    const gaps = this.gaps();
    const sides = this.seams.map((seam, k) => {
      let move = welder.moves.get(pairKey(seam.owner, seam.other));
      const other = this.patch(seam.other);
      const own = (y: number) => {
        const p = sidePoint(seam.otherSide, y);
        return at(other, p[0], p[1]);
      };
      for (const [j, point] of seam.points.entries()) {
        const c = this.classes[seam.cls[j] as number] as { point: Tuple3 };
        const y = seam.mapped[j] as number;
        // The corner a class merges, and the other side's isoparm sliding onto the sample.
        const d = Math.max(
          length(sub(c.point, point)),
          Number.isNaN(y) ? 0 : length(sub(own(y), own(seam.raw[j] as number))),
        );
        if (d > (move?.distance ?? 0)) move = { distance: d, at: c.point };
      }
      return {
        owner: seam.owner,
        seam: {
          a: names[seam.owner] as string,
          sideA: PUBLIC_SIDE[seam.ownerSide],
          b: names[seam.other] as string,
          sideB: PUBLIC_SIDE[seam.otherSide],
          gap: (gaps[k] as { gap: number }).gap,
          weldMove: move?.distance ?? 0,
          ...(move === undefined ? {} : { weldAt: move.at }),
        },
      };
    });
    const trimGaps = this.trimGaps();
    const trims = this.trimSeams.map((seam, k) => {
      let move = welder.moves.get(pairKey(seam.band, seam.face));
      for (const [j, point] of seam.points.entries()) {
        const c = this.classes[seam.cls[j] as number] as { point: Tuple3 };
        // The class point's merge, and the face's point (a pinned crossing) moving onto the sample.
        const d = Math.max(length(sub(c.point, point)), seam.move[j] as number);
        if (d > (move?.distance ?? 0)) move = { distance: d, at: c.point };
      }
      return {
        owner: seam.band,
        seam: {
          a: names[seam.band] as string,
          sideA: PUBLIC_SIDE[seam.side],
          b: names[seam.face] as string,
          sideB: `trim${seam.trim}` as const,
          gap: (trimGaps[k] as { gap: number }).gap,
          weldMove: move?.distance ?? 0,
          ...(move === undefined ? {} : { weldAt: move.at }),
        },
      };
    });
    return [...sides, ...trims];
  }
}

function label(names: readonly string[], seam: Seam): string {
  return `${names[seam.owner]}:${PUBLIC_SIDE[seam.ownerSide]}|${names[seam.other]}:${PUBLIC_SIDE[seam.otherSide]}`;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * The positional weld that remains: vertices of one patch merge within `own` (a trim passing
 * near a grid node leaves no sliver), vertices of different patches only within `cross` (the
 * model tolerance at most: coincidences no seam pairs). A seam vertex belongs to every patch
 * that uses it. `moves` keeps the largest merge between two patches, by patch pair.
 */
export class Welder3 {
  readonly moves = new Map<string, { distance: number; at: Tuple3 }>();
  private readonly cells = new Map<string, number[]>();
  private readonly users = new Map<number, number[]>();
  private readonly mesh: EditMesh;
  private readonly own: number;
  private readonly cross: number;

  constructor(mesh: EditMesh, own: number, cross: number) {
    this.mesh = mesh;
    this.own = own;
    this.cross = cross;
  }

  /** Patch `patch` uses vertex `v` (a seam vertex another patch created). */
  use(v: number, patch: number): void {
    const list = this.users.get(v) as number[];
    if (!list.includes(patch)) list.push(patch);
  }

  id(p: Tuple3, patch: number, seam = false): number {
    const size = Math.max(this.own, this.cross);
    const c = p.map((x) => Math.floor(x / size));
    let best = -1;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const v of this.cells.get(
            `${(c[0] as number) + dx},${(c[1] as number) + dy},${(c[2] as number) + dz}`,
          ) ?? []) {
            const d = length(sub(this.mesh.position(v), p));
            const limit =
              !seam && this.users.get(v)?.includes(patch) === true ? this.own : this.cross;
            if (d <= limit && d < bestD) {
              best = v;
              bestD = d;
            }
          }
        }
      }
    }
    if (best >= 0) {
      const users = this.users.get(best) as number[];
      if (!users.includes(patch)) {
        if (bestD > 0)
          for (const from of users) {
            const key = pairKey(from, patch);
            if (bestD > (this.moves.get(key)?.distance ?? 0))
              this.moves.set(key, { distance: bestD, at: this.mesh.position(best) });
          }
        users.push(patch);
      }
      return best;
    }
    const v = this.mesh.addVertex(p[0], p[1], p[2]);
    this.users.set(v, [patch]);
    const key = `${c[0]},${c[1]},${c[2]}`;
    const list = this.cells.get(key);
    if (list === undefined) this.cells.set(key, [v]);
    else list.push(v);
    return v;
  }
}
