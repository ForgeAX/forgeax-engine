import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf } from '../arrays';
import { faceLoops } from './faces';
import type { Coedge, Curve, Edge, Face, Shape, Surface } from './types';
import { add3, cross3, dot3, len3, type P3, scale3, sub3, unit3 } from './vec';

/**
 * Rectilinear planar faces (L, U, T, staircase outlines with straight edges and right-angle corners, no holes) as a
 * tensor lattice. The grid lines run through every outline vertex; each line interval carries a sample count, and
 * every outline edge carries the sum of the counts it spans. Cells inside the outline become strict quad blocks, so
 * the face is all quads with scaled Jacobian 1 away from the boundary where the generic trimmed route triangulates,
 * pairs and distorts. Sample positions of the outline edges follow the intervals (piecewise uniform) so the lattice
 * lines stay straight; every other face reads those same shared samples.
 */

type Step<T> = Result<T, string>;

export interface RectEdge {
  readonly edge: number;
  readonly coedge: number;
  /** 0: the edge runs along u, 1: along v. */
  readonly axis: 0 | 1;
  /** Grid line on the other axis that carries the edge. */
  readonly line: number;
  /** Intervals covered along the axis: `lo` inclusive, `hi` exclusive. */
  readonly lo: number;
  readonly hi: number;
  /** The coedge runs toward increasing u (or v). */
  readonly forward: boolean;
}

export interface RectFace {
  readonly face: number;
  readonly origin: P3;
  readonly e1: P3;
  readonly e2: P3;
  readonly us: readonly number[];
  readonly vs: readonly number[];
  /** `inside[j][i]`: cell of u-interval i and v-interval j lies in the outline. */
  readonly inside: readonly (readonly boolean[])[];
  readonly edges: readonly RectEdge[];
}

export interface RectPlan {
  readonly rect: RectFace;
  readonly nu: readonly number[];
  readonly nv: readonly number[];
}

const REL_TOL = 1e-9;

function uniqueSorted(values: readonly number[], tol: number): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (out.length === 0 || v - (out[out.length - 1] as number) > tol) out.push(v);
  }
  return out;
}

function indexOf(lines: readonly number[], x: number, tol: number): number {
  for (let i = 0; i < lines.length; i++) if (Math.abs((lines[i] as number) - x) <= tol) return i;
  return -1;
}

function pointInside(poly: readonly (readonly [number, number])[], u: number, v: number): boolean {
  let inside = false;
  for (let k = 0, n = poly.length; k < n; k++) {
    const a = poly[k] as readonly [number, number];
    const b = poly[(k + 1) % n] as readonly [number, number];
    if (a[1] > v !== b[1] > v && u < a[0] + ((v - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) {
      inside = !inside;
    }
  }
  return inside;
}

/** The lattice description of a holeless planar face whose outline is rectilinear with six or more line edges. */
export function analyzeRect(shape: Shape, f: number): RectFace | undefined {
  const face = shape.faces[f] as Face;
  const surface = shape.surfaces[face.surface] as Surface;
  if (surface.kind !== 'plane') return undefined;
  const { outer, holes } = faceLoops(shape, f);
  const n = outer.length;
  if (holes.length > 0 || n < 6 || n % 2 !== 0) return undefined;
  const starts: number[] = [];
  const ends: number[] = [];
  for (const c of outer) {
    const co = shape.coedges[c] as Coedge;
    const edge = shape.edges[co.edge] as Edge;
    if (edge.curve < 0 || (shape.curves[edge.curve] as Curve).kind !== 'line') return undefined;
    starts.push(co.reversed ? edge.v1 : edge.v0);
    ends.push(co.reversed ? edge.v0 : edge.v1);
  }
  for (let k = 0; k < n; k++) if (ends[k] !== starts[(k + 1) % n]) return undefined;
  const points = starts.map((v) => (shape.vertices[v] as { p: P3 }).p);
  const origin = points[0] as P3;
  const first = sub3(points[1] as P3, origin);
  if (len3(first) === 0) return undefined;
  const e1 = unit3(first);
  const e2 = cross3(unit3(surface.frame.z), e1);
  if (len3(e2) === 0) return undefined;
  const uv = points.map((p): [number, number] => {
    const d = sub3(p, origin);
    return [dot3(d, e1), dot3(d, e2)];
  });
  const span = maxOf(uv.map(([u, v]) => Math.max(Math.abs(u), Math.abs(v))));
  const tol = REL_TOL * Math.max(span, 1e-12);
  let area = 0;
  const axes: (0 | 1)[] = [];
  for (let k = 0; k < n; k++) {
    const a = uv[k] as [number, number];
    const b = uv[(k + 1) % n] as [number, number];
    area += a[0] * b[1] - b[0] * a[1];
    const du = Math.abs(b[0] - a[0]);
    const dv = Math.abs(b[1] - a[1]);
    if (du <= tol === dv <= tol) return undefined;
    axes.push(du > tol ? 0 : 1);
  }
  if (area <= 0) return undefined;
  for (let k = 0; k < n; k++) if (axes[k] === axes[(k + 1) % n]) return undefined;
  const us = uniqueSorted(
    uv.map((p) => p[0]),
    tol,
  );
  const vs = uniqueSorted(
    uv.map((p) => p[1]),
    tol,
  );
  const inside: boolean[][] = [];
  for (let j = 0; j + 1 < vs.length; j++) {
    const row: boolean[] = [];
    for (let i = 0; i + 1 < us.length; i++) {
      row.push(
        pointInside(
          uv,
          ((us[i] as number) + (us[i + 1] as number)) / 2,
          ((vs[j] as number) + (vs[j + 1] as number)) / 2,
        ),
      );
    }
    inside.push(row);
  }
  const edges: RectEdge[] = [];
  let spanned = 0;
  for (let k = 0; k < n; k++) {
    const a = uv[k] as [number, number];
    const b = uv[(k + 1) % n] as [number, number];
    const axis = axes[k] as 0 | 1;
    const lines = axis === 0 ? us : vs;
    const across = axis === 0 ? vs : us;
    const from = indexOf(lines, a[axis], tol);
    const to = indexOf(lines, b[axis], tol);
    const line = indexOf(across, a[axis === 0 ? 1 : 0], tol);
    if (from < 0 || to < 0 || line < 0) return undefined;
    const co = shape.coedges[outer[k] as number] as Coedge;
    edges.push({
      edge: co.edge,
      coedge: outer[k] as number,
      axis,
      line,
      lo: Math.min(from, to),
      hi: Math.max(from, to),
      forward: to > from,
    });
    spanned += Math.abs(to - from);
  }
  const cell = (j: number, i: number): boolean => inside[j]?.[i] === true;
  let boundary = 0;
  for (let j = 0; j <= vs.length - 1; j++) {
    for (let i = 0; i + 1 < us.length; i++) if (cell(j - 1, i) !== cell(j, i)) boundary++;
  }
  for (let i = 0; i <= us.length - 1; i++) {
    for (let j = 0; j + 1 < vs.length; j++) if (cell(j, i - 1) !== cell(j, i)) boundary++;
  }
  if (boundary !== spanned) return undefined;
  return { face: f, origin, e1, e2, us, vs, inside, edges };
}

/**
 * Interval counts for the solved edge counts: each starts at the rounded interval length over the element size, then
 * the widest-spaced interval under any edge is raised until its span sum reaches the edge count. Sums never fall below
 * the counts, so raising the edge floors to the sums (and re-solving) converges on counts that equal their sums.
 */
export function rectIntervals(
  rect: RectFace,
  size: number,
  countOf: (edge: number) => number,
  shortFirst = false,
): { nu: number[]; nv: number[] } {
  const nu = rect.us
    .slice(0, -1)
    .map((u, i) => Math.max(1, Math.round(((rect.us[i + 1] as number) - u) / size)));
  const nv = rect.vs
    .slice(0, -1)
    .map((v, j) => Math.max(1, Math.round(((rect.vs[j + 1] as number) - v) / size)));
  // A long edge raised before the short edges it spans can overshoot them for ever; `shortFirst` raises the short edges
  // first, so a long edge only adds the shortfall that remains.
  const order = shortFirst
    ? [...rect.edges].sort((a, b) => a.hi - a.lo - (b.hi - b.lo))
    : rect.edges;
  for (const e of order) {
    const counts = e.axis === 0 ? nu : nv;
    const lines = e.axis === 0 ? rect.us : rect.vs;
    const want = countOf(e.edge);
    for (;;) {
      let sum = 0;
      for (let i = e.lo; i < e.hi; i++) sum += counts[i] as number;
      if (sum >= want) break;
      let best = e.lo;
      let bestSpacing = -1;
      for (let i = e.lo; i < e.hi; i++) {
        const spacing = ((lines[i + 1] as number) - (lines[i] as number)) / (counts[i] as number);
        if (spacing > bestSpacing) {
          bestSpacing = spacing;
          best = i;
        }
      }
      counts[best] = (counts[best] as number) + 1;
    }
  }
  return { nu, nv };
}

/** Count each rectilinear edge must reach so it equals the sum of the intervals it spans; absent when already equal. */
export function rectFloors(
  rects: readonly RectFace[],
  size: number,
  counts: ReadonlyMap<number, number>,
  shortFirst = false,
): Map<number, number> {
  const floors = new Map<number, number>();
  for (const rect of rects) {
    const { nu, nv } = rectIntervals(rect, size, (e) => counts.get(e) ?? 0, shortFirst);
    for (const e of rect.edges) {
      const per = e.axis === 0 ? nu : nv;
      let sum = 0;
      for (let i = e.lo; i < e.hi; i++) sum += per[i] as number;
      if (sum !== (counts.get(e.edge) ?? 0))
        floors.set(e.edge, Math.max(floors.get(e.edge) ?? 0, sum));
    }
  }
  return floors;
}

/** Ring whose edge counts must total an even number: the part of a ring constraint the settle search reads. */
export interface ParityRing {
  readonly edges: readonly number[];
}

export interface SettleHost {
  /** Counts of one floor vector under the edge classes alone (no parity rings); absent when unsatisfiable. */
  readonly solve: (floor: readonly number[]) => ReadonlyMap<number, number> | undefined;
  readonly rects: readonly RectFace[];
  readonly size: number;
  /** Rings of the faces outside the lattices; a lattice face with matching sums is even by construction. */
  readonly rings: readonly ParityRing[];
}

export interface Settled {
  readonly floor: number[];
  readonly counts: ReadonlyMap<number, number>;
}

const SETTLE_PASSES = 12;
const SETTLE_REPAIRS = 24;

function oddRings(rings: readonly ParityRing[], counts: ReadonlyMap<number, number>): number {
  let odd = 0;
  for (const r of rings) {
    let sum = 0;
    for (const e of r.edges) sum += counts.get(e) ?? 0;
    if (sum % 2 !== 0) odd++;
  }
  return odd;
}

/**
 * Floor vector whose solved counts equal every lattice sum and make every other ring even, or undefined. Floors rise
 * to the sums until they hold; a remaining odd ring tries each of its edges raised by one (the lattices absorb the
 * raise and move other edges with it) and keeps the trial that leaves the fewest odd rings, then the fewest samples.
 */
export function settleRect(
  host: SettleHost,
  start: readonly number[],
  shortFirst = false,
): Settled | undefined {
  const converge = (from: readonly number[]): Settled | undefined => {
    const floor = from.slice();
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      const counts = host.solve(floor);
      if (counts === undefined) return undefined;
      const floors = rectFloors(host.rects, host.size, counts, shortFirst);
      for (const [e, n] of counts) floor[e] = Math.max(floor[e] as number, n);
      if (floors.size === 0) return { floor, counts };
      for (const [e, n] of floors) floor[e] = Math.max(floor[e] as number, n);
    }
    return undefined;
  };
  let state = converge(start);
  for (let repair = 0; state !== undefined && repair < SETTLE_REPAIRS; repair++) {
    const odd = oddRings(host.rings, state.counts);
    if (odd === 0) return state;
    const current: Settled = state;
    const ring = host.rings.find((r) => oddRings([r], current.counts) > 0);
    let best: Settled | undefined;
    let bestOdd = odd;
    let bestSum = Infinity;
    for (const e of [...new Set(ring?.edges ?? [])].sort((a, b) => a - b)) {
      const trial = current.floor.slice();
      trial[e] = (current.counts.get(e) ?? 0) + 1;
      const next = converge(trial);
      if (next === undefined) continue;
      const nextOdd = oddRings(host.rings, next.counts);
      let sum = 0;
      for (const n of next.counts.values()) sum += n;
      if (nextOdd < bestOdd || (nextOdd === bestOdd && best !== undefined && sum < bestSum)) {
        best = next;
        bestOdd = nextOdd;
        bestSum = sum;
      }
    }
    if (best === undefined) return undefined;
    state = best;
  }
  return state !== undefined && oddRings(host.rings, state.counts) === 0 ? state : undefined;
}

/** Fractions (0..1) of the edge's arc along its own direction for each sample, piecewise uniform per interval. */
function edgeFractions(
  rect: RectFace,
  e: RectEdge,
  per: readonly number[],
  coedge: Coedge,
): number[] {
  const lines = e.axis === 0 ? rect.us : rect.vs;
  const width = (lines[e.hi] as number) - (lines[e.lo] as number);
  const along: number[] = [0];
  const order: number[] = [];
  for (let i = e.lo; i < e.hi; i++) order.push(i);
  if (!e.forward) order.reverse();
  for (const i of order) {
    const w = ((lines[i + 1] as number) - (lines[i] as number)) / width;
    const last = along[along.length - 1] as number;
    const m = per[i] as number;
    for (let k = 1; k <= m; k++) along.push(last + (w * k) / m);
  }
  along[along.length - 1] = 1;
  return coedge.reversed ? along.map((x) => 1 - x).reverse() : along;
}

/**
 * Plans for every rectilinear face whose edges all carry counts equal to their interval sums and whose shared edges
 * agree on sample positions; the others stay with the generic route. `fractions` maps an edge to the arc fraction of
 * each of its samples in the edge's own direction.
 */
export function planRects(
  shape: Shape,
  size: number,
  counts: ReadonlyMap<number, number>,
  shortFirst = false,
): { plans: Map<number, RectPlan>; fractions: Map<number, number[]> } {
  const plans = new Map<number, RectPlan>();
  const fractions = new Map<number, number[]>();
  for (let f = 0; f < shape.faces.length; f++) {
    const rect = analyzeRect(shape, f);
    if (rect === undefined) continue;
    const { nu, nv } = rectIntervals(rect, size, (e) => counts.get(e) ?? 0, shortFirst);
    const proposed = new Map<number, number[]>();
    let usable = true;
    for (const e of rect.edges) {
      const per = e.axis === 0 ? nu : nv;
      let sum = 0;
      for (let i = e.lo; i < e.hi; i++) sum += per[i] as number;
      if (sum !== counts.get(e.edge)) usable = false;
      proposed.set(e.edge, edgeFractions(rect, e, per, shape.coedges[e.coedge] as Coedge));
    }
    if (!usable) continue;
    // A shared edge keeps the samples its first face registered (same count, positions of the first lattice).
    for (const [edge, fr] of proposed) if (!fractions.has(edge)) fractions.set(edge, fr);
    plans.set(f, { rect, nu, nv });
  }
  return { plans, fractions };
}

export interface RectHost {
  /** Shared samples of a B-rep edge in the edge's own direction (the fractions planned for it are applied). */
  readonly edgeSamples: (edge: number) => Step<number[]>;
  readonly vertex: (p: P3) => number;
  readonly shape: Shape;
}

/** Quads of one planned face, wound with its outline; fails closed when the shared samples do not fit the lattice. */
export function rectQuads(plan: RectPlan, host: RectHost): Step<number[][]> {
  const { rect, nu, nv } = plan;
  const lat = (per: readonly number[]): number[] => {
    const out = [0];
    for (const m of per) out.push((out[out.length - 1] as number) + m);
    return out;
  };
  const lu = lat(nu);
  const lv = lat(nv);
  const NV = lv[lv.length - 1] as number;
  const key = (U: number, V: number): number => U * (NV + 1) + V;
  const ids = new Map<number, number>();
  for (const e of rect.edges) {
    const co = host.shape.coedges[e.coedge] as Coedge;
    const sampled = host.edgeSamples(e.edge);
    if (!sampled.ok) return sampled;
    const seq = co.reversed ? sampled.value.slice().reverse() : sampled.value.slice();
    const per = e.axis === 0 ? nu : nv;
    const along = e.axis === 0 ? lu : lv;
    let sum = 0;
    for (let i = e.lo; i < e.hi; i++) sum += per[i] as number;
    if (seq.length - 1 !== sum) return err('rect-count-mismatch');
    const startAt = e.forward ? (along[e.lo] as number) : (along[e.hi] as number);
    const step = e.forward ? 1 : -1;
    for (let j = 0; j < seq.length; j++) {
      const at = startAt + step * j;
      const k = e.axis === 0 ? key(at, lv[e.line] as number) : key(lu[e.line] as number, at);
      const known = ids.get(k);
      if (known !== undefined && known !== seq[j]) return err('rect-node-conflict');
      ids.set(k, seq[j] as number);
    }
  }
  const unitCell = (U: number, V: number): boolean => {
    if (U < 0 || V < 0 || U >= (lu[lu.length - 1] as number) || V >= NV) return false;
    let i = 0;
    while (i + 1 < nu.length && U >= (lu[i + 1] as number)) i++;
    let j = 0;
    while (j + 1 < nv.length && V >= (lv[j + 1] as number)) j++;
    return rect.inside[j]?.[i] === true;
  };
  const cells: [number, number][] = [];
  const missing = new Map<number, [number, number]>();
  for (let V = 0; V < NV; V++) {
    for (let U = 0; U < (lu[lu.length - 1] as number); U++) {
      if (!unitCell(U, V)) continue;
      cells.push([U, V]);
      for (const [du, dv] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ] as const) {
        const k = key(U + du, V + dv);
        if (!ids.has(k)) missing.set(k, [U + du, V + dv]);
      }
    }
  }
  for (const [U, V] of missing.values()) {
    if (!(unitCell(U - 1, V - 1) && unitCell(U, V - 1) && unitCell(U - 1, V) && unitCell(U, V))) {
      return err('rect-boundary-node-missing');
    }
  }
  const position = (U: number, V: number): P3 => {
    const place = (
      lines: readonly number[],
      per: readonly number[],
      lt: readonly number[],
      at: number,
    ): number => {
      let i = 0;
      while (i + 2 < lt.length && at > (lt[i + 1] as number)) i++;
      const t = (at - (lt[i] as number)) / (per[i] as number);
      return (lines[i] as number) + ((lines[i + 1] as number) - (lines[i] as number)) * t;
    };
    const u = place(rect.us, nu, lu, U);
    const v = place(rect.vs, nv, lv, V);
    return add3(rect.origin, add3(scale3(rect.e1, u), scale3(rect.e2, v)));
  };
  for (const [k, [U, V]] of missing) ids.set(k, host.vertex(position(U, V)));
  const quads = cells.map(([U, V]) => [
    ids.get(key(U, V)) as number,
    ids.get(key(U + 1, V)) as number,
    ids.get(key(U + 1, V + 1)) as number,
    ids.get(key(U, V + 1)) as number,
  ]);
  return ok(quads);
}
