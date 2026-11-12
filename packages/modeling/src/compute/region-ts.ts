import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { orient2d } from '../predicates';
import type { Point2 } from '../primitives';
import type {
  BackendOutput,
  ComputeJobRequest,
  EdgeProvenance,
  RegionJobParams,
  WorkMeter,
} from './job';

/**
 * TypeScript baseline of the `region` compute job: 2D boolean, offset and stroke of
 * outlines with holes. Every operation is one arrangement: input edges are split at
 * their intersections, welded within the tolerance, and each undirected piece keeps
 * the direction whose left side is inside the result (winding numbers just beside
 * the piece decide), so coincident edges and touching outlines need no special case.
 */

/** A shape: one counter-clockwise outline and clockwise holes (any input order is normalized). */
export interface Shape2 {
  readonly outer: readonly Point2[];
  readonly holes?: readonly (readonly Point2[])[];
}

/** A region: disjoint shapes, each an outline with holes. */
export type Region2 = readonly Shape2[];

const PI = Math.PI;

/** Canonical bytes of a region: f64 shape count, then per shape ring count and rings. */
export function encodeRegion(region: Region2): Uint8Array {
  const values: number[] = [region.length];
  for (const shape of region) {
    const rings = [shape.outer, ...(shape.holes ?? [])];
    values.push(rings.length);
    for (const ring of rings) {
      values.push(ring.length);
      for (const p of ring) values.push(p[0], p[1]);
    }
  }
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  for (const [i, v] of values.entries()) view.setFloat64(i * 8, v, true);
  return out;
}

export function decodeRegion(bytes: Uint8Array): Result<Region2, ModelingError> {
  const bad = () =>
    err(
      modelingError('model-invalid-argument', 'region bytes come from encodeRegion', {
        bytes: bytes.length,
      }),
    );
  if (bytes.length % 8 !== 0) return bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length / 8;
  let at = 0;
  const next = (): number | undefined => (at < count ? view.getFloat64(8 * at++, true) : undefined);
  const counted = (): number | undefined => {
    const n = next();
    return n !== undefined && Number.isInteger(n) && n >= 0 && n <= count ? n : undefined;
  };
  const shapes = counted();
  if (shapes === undefined) return bad();
  const region: Shape2[] = [];
  for (let s = 0; s < shapes; s++) {
    const rings = counted();
    if (rings === undefined || rings < 1) return bad();
    const parsed: Point2[][] = [];
    for (let r = 0; r < rings; r++) {
      const n = counted();
      if (n === undefined) return bad();
      const ring: Point2[] = [];
      for (let i = 0; i < n; i++) {
        const x = next();
        const y = next();
        if (x === undefined || y === undefined) return bad();
        ring.push([x, y]);
      }
      parsed.push(ring);
    }
    const [outer, ...holes] = parsed as [Point2[], ...Point2[][]];
    region.push(holes.length === 0 ? { outer } : { outer, holes });
  }
  if (at !== count) return bad();
  return ok(region);
}

function signedArea(ring: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point2;
    const b = ring[(i + 1) % ring.length] as Point2;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

/** Drop repeated and closing points; orient counter-clockwise when `ccw`, else clockwise. */
function cleanRing(ring: readonly Point2[], ccw: boolean): Point2[] {
  const out: Point2[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  while (out.length > 1) {
    const first = out[0] as Point2;
    const last = out[out.length - 1] as Point2;
    if (first[0] !== last[0] || first[1] !== last[1]) break;
    out.pop();
  }
  if (out.length < 3) return [];
  const area = signedArea(out);
  if (area === 0) return [];
  return area > 0 === ccw ? out : out.reverse();
}

interface Segment {
  readonly a: Point2;
  readonly b: Point2;
  readonly operand: number;
  readonly ring: number;
  readonly edge: number;
}

interface SourceRings {
  readonly rings: Point2[][];
  readonly operand: number;
}

function ringSegments(source: SourceRings, out: Segment[]): void {
  for (const [r, ring] of source.rings.entries()) {
    for (let i = 0; i < ring.length; i++) {
      out.push({
        a: ring[i] as Point2,
        b: ring[(i + 1) % ring.length] as Point2,
        operand: source.operand,
        ring: r,
        edge: i,
      });
    }
  }
}

/** Every ring of a region, outlines counter-clockwise and holes clockwise. */
function normalizedRings(region: Region2): Point2[][] {
  const rings: Point2[][] = [];
  for (const shape of region) {
    rings.push(cleanRing(shape.outer, true));
    for (const hole of shape.holes ?? []) rings.push(cleanRing(hole, false));
  }
  return rings;
}

// ---- arrangement ----------------------------------------------------------------

interface Piece {
  readonly u: number;
  readonly v: number;
  readonly operand: number;
  readonly ring: number;
  readonly edge: number;
}

interface Arrangement {
  readonly points: Point2[];
  readonly pieces: Piece[];
  readonly intersections: number;
}

class Welder {
  readonly points: Point2[] = [];
  private readonly cells = new Map<string, number[]>();
  private readonly tolerance: number;

  constructor(tolerance: number) {
    this.tolerance = tolerance;
  }

  private cell(x: number, y: number): [number, number] {
    return [Math.floor(x / this.tolerance), Math.floor(y / this.tolerance)];
  }

  id(p: Point2): number {
    const [cx, cy] = this.cell(p[0], p[1]);
    const t2 = this.tolerance * this.tolerance;
    let best = -1;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const q = this.points[i] as Point2;
          const d = (q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]);
          if (d <= t2 && d < bestD) {
            best = i;
            bestD = d;
          }
        }
      }
    }
    if (best >= 0) return best;
    const id = this.points.length;
    this.points.push(p);
    const key = `${cx},${cy}`;
    const list = this.cells.get(key);
    if (list === undefined) this.cells.set(key, [id]);
    else list.push(id);
    return id;
  }
}

function arrange(
  segments: readonly Segment[],
  tolerance: number,
  work: WorkMeter,
): Result<Arrangement, ModelingError> {
  const splits: { t: number; p: Point2 }[][] = segments.map(() => []);
  const order = segments
    .map((s, i) => ({ i, min: Math.min(s.a[0], s.b[0]), max: Math.max(s.a[0], s.b[0]) }))
    .sort((x, y) => x.min - y.min || x.i - y.i);
  let intersections = 0;
  const param = (s: Segment, p: Point2) => {
    const dx = s.b[0] - s.a[0];
    const dy = s.b[1] - s.a[1];
    return ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / (dx * dx + dy * dy);
  };
  const addSplit = (k: number, p: Point2) => {
    const s = segments[k] as Segment;
    const t = param(s, p);
    if (t > 0 && t < 1) (splits[k] as { t: number; p: Point2 }[]).push({ t, p });
  };
  for (let x = 0; x < order.length; x++) {
    const oi = order[x] as { i: number; max: number };
    const si = segments[oi.i] as Segment;
    const minYi = Math.min(si.a[1], si.b[1]);
    const maxYi = Math.max(si.a[1], si.b[1]);
    for (let y = x + 1; y < order.length; y++) {
      const oj = order[y] as { i: number; min: number };
      if (oj.min > oi.max + tolerance) break;
      if (!work.spend(1)) return err(work.failure as ModelingError);
      const sj = segments[oj.i] as Segment;
      if (
        Math.min(sj.a[1], sj.b[1]) > maxYi + tolerance ||
        Math.max(sj.a[1], sj.b[1]) < minYi - tolerance
      ) {
        continue;
      }
      const o1 = orient2d(si.a[0], si.a[1], si.b[0], si.b[1], sj.a[0], sj.a[1]);
      const o2 = orient2d(si.a[0], si.a[1], si.b[0], si.b[1], sj.b[0], sj.b[1]);
      const o3 = orient2d(sj.a[0], sj.a[1], sj.b[0], sj.b[1], si.a[0], si.a[1]);
      const o4 = orient2d(sj.a[0], sj.a[1], sj.b[0], sj.b[1], si.b[0], si.b[1]);
      if (o1 === 0 && o2 === 0) {
        addSplit(oi.i, sj.a);
        addSplit(oi.i, sj.b);
        addSplit(oj.i, si.a);
        addSplit(oj.i, si.b);
        continue;
      }
      if ((o1 > 0 && o2 > 0) || (o1 < 0 && o2 < 0) || (o3 > 0 && o4 > 0) || (o3 < 0 && o4 < 0)) {
        continue;
      }
      if (o1 === 0) addSplit(oi.i, sj.a);
      if (o2 === 0) addSplit(oi.i, sj.b);
      if (o3 === 0) addSplit(oj.i, si.a);
      if (o4 === 0) addSplit(oj.i, si.b);
      if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) {
        const t = o3 / (o3 - o4);
        const p: Point2 = [si.a[0] + t * (si.b[0] - si.a[0]), si.a[1] + t * (si.b[1] - si.a[1])];
        addSplit(oi.i, p);
        addSplit(oj.i, p);
        intersections++;
      }
    }
  }
  const welder = new Welder(tolerance);
  const pieces: Piece[] = [];
  for (const [k, s] of segments.entries()) {
    const ids = [welder.id(s.a)];
    const list = (splits[k] as { t: number; p: Point2 }[]).sort((p, q) => p.t - q.t);
    for (const split of list) ids.push(welder.id(split.p));
    ids.push(welder.id(s.b));
    for (let i = 0; i + 1 < ids.length; i++) {
      const u = ids[i] as number;
      const v = ids[i + 1] as number;
      if (u !== v) pieces.push({ u, v, operand: s.operand, ring: s.ring, edge: s.edge });
    }
  }
  return ok({ points: welder.points, pieces, intersections });
}

/** Winding numbers of `q` per operand (Sunday's crossing rule, exact orientation). */
function windingAt(
  q: Point2,
  points: readonly Point2[],
  pieces: readonly Piece[],
  operands: number,
): number[] {
  const w = new Array<number>(operands).fill(0);
  for (const piece of pieces) {
    const a = points[piece.u] as Point2;
    const b = points[piece.v] as Point2;
    if (a[1] <= q[1]) {
      if (b[1] > q[1] && orient2d(a[0], a[1], b[0], b[1], q[0], q[1]) > 0) {
        w[piece.operand] = (w[piece.operand] as number) + 1;
      }
    } else if (b[1] <= q[1] && orient2d(a[0], a[1], b[0], b[1], q[0], q[1]) < 0) {
      w[piece.operand] = (w[piece.operand] as number) - 1;
    }
  }
  return w;
}

/** Inside predicate of the result from per-operand winding numbers. */
type Inside = (w: readonly number[]) => boolean;

function insideFor(operation: RegionJobParams['operation']): Inside {
  switch (operation) {
    case 'union':
      return (w) => (w[0] as number) > 0 || (w[1] as number) > 0;
    case 'intersection':
      return (w) => (w[0] as number) > 0 && (w[1] as number) > 0;
    case 'difference':
      return (w) => (w[0] as number) > 0 && !((w[1] as number) > 0);
    case 'xor':
      return (w) => (w[0] as number) > 0 !== (w[1] as number) > 0;
    case 'offset':
    case 'stroke':
      return (w) => (w[0] as number) > 0;
  }
}

interface Directed {
  readonly u: number;
  readonly v: number;
  readonly source: Piece;
}

/** Pieces of the result boundary, directed with the inside on the left. */
function classify(
  arrangement: Arrangement,
  operands: number,
  inside: Inside,
  tolerance: number,
  work: WorkMeter,
): Result<Directed[], ModelingError> {
  const { points, pieces } = arrangement;
  const groups = new Map<string, Piece[]>();
  for (const piece of pieces) {
    const key = piece.u < piece.v ? `${piece.u},${piece.v}` : `${piece.v},${piece.u}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [piece]);
    else group.push(piece);
  }
  const out: Directed[] = [];
  for (const group of groups.values()) {
    if (!work.spend(pieces.length)) return err(work.failure as ModelingError);
    const first = group[0] as Piece;
    const u = Math.min(first.u, first.v);
    const v = Math.max(first.u, first.v);
    const a = points[u] as Point2;
    const b = points[v] as Point2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const eps = Math.min(tolerance / 4, len / 4);
    const right: Point2 = [
      (a[0] + b[0]) / 2 + (dy / len) * eps,
      (a[1] + b[1]) / 2 - (dx / len) * eps,
    ];
    const wRight = windingAt(right, points, pieces, operands);
    const wLeft = [...wRight];
    for (const piece of group) {
      wLeft[piece.operand] = (wLeft[piece.operand] as number) + (piece.u === u ? 1 : -1);
    }
    const inLeft = inside(wLeft);
    const inRight = inside(wRight);
    if (inLeft === inRight) continue;
    const source =
      group.find((p) => (p.u === u) === inLeft) ??
      group.reduce((x, y) => (y.operand < x.operand ? y : x));
    out.push(inLeft ? { u, v, source } : { u: v, v: u, source });
  }
  return ok(out);
}

/** Diamond angle of a direction in [0, 4), counter-clockwise from +x. */
function pseudoAngle(dx: number, dy: number): number {
  const p = dy / (Math.abs(dx) + Math.abs(dy));
  return dx < 0 ? 2 - p : dy < 0 ? 4 + p : p;
}

interface TracedRing {
  readonly points: Point2[];
  readonly sources: Piece[];
  readonly area: number;
}

/** Chain directed pieces into rings, at each vertex turning as far left as possible. */
function trace(points: readonly Point2[], directed: readonly Directed[]): TracedRing[] {
  const outgoing = new Map<number, number[]>();
  for (const [i, d] of directed.entries()) {
    const list = outgoing.get(d.u);
    if (list === undefined) outgoing.set(d.u, [i]);
    else list.push(i);
  }
  const used = new Uint8Array(directed.length);
  const rings: TracedRing[] = [];
  for (let start = 0; start < directed.length; start++) {
    if (used[start] === 1) continue;
    const ids: number[] = [];
    let current = start;
    for (;;) {
      used[current] = 1;
      ids.push(current);
      const d = directed[current] as Directed;
      if (d.v === (directed[start] as Directed).u) break;
      const at = points[d.v] as Point2;
      const from = points[d.u] as Point2;
      const back = pseudoAngle(from[0] - at[0], from[1] - at[1]);
      let best = -1;
      let bestTurn = Infinity;
      for (const c of outgoing.get(d.v) ?? []) {
        if (used[c] === 1) continue;
        const to = points[(directed[c] as Directed).v] as Point2;
        let turn = back - pseudoAngle(to[0] - at[0], to[1] - at[1]);
        if (turn <= 0) turn += 4;
        if (turn < bestTurn) {
          bestTurn = turn;
          best = c;
        }
      }
      if (best < 0) break;
      current = best;
    }
    const ringPoints = ids.map((i) => points[(directed[i] as Directed).u] as Point2);
    const sources = ids.map((i) => (directed[i] as Directed).source);
    // Merge collinear runs that come from one source edge.
    const n = ringPoints.length;
    const keep = ringPoints.map((p, i) => {
      const prev = ringPoints[(i + n - 1) % n] as Point2;
      const next = ringPoints[(i + 1) % n] as Point2;
      const a = sources[(i + n - 1) % n] as Piece;
      const b = sources[i] as Piece;
      const sameSource = a.operand === b.operand && a.ring === b.ring && a.edge === b.edge;
      return !(sameSource && orient2d(prev[0], prev[1], p[0], p[1], next[0], next[1]) === 0);
    });
    const kept = ringPoints.filter((_, i) => keep[i] === true);
    const keptSources = sources.filter((_, i) => keep[i] === true);
    if (kept.length < 3) continue;
    const area = signedArea(kept);
    if (area === 0) continue;
    rings.push({ points: kept, sources: keptSources, area });
  }
  return rings;
}

function ringContains(ring: readonly Point2[], q: Point2): boolean {
  let w = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point2;
    const b = ring[(i + 1) % ring.length] as Point2;
    if (a[1] <= q[1]) {
      if (b[1] > q[1] && orient2d(a[0], a[1], b[0], b[1], q[0], q[1]) > 0) w++;
    } else if (b[1] <= q[1] && orient2d(a[0], a[1], b[0], b[1], q[0], q[1]) < 0) w--;
  }
  return w !== 0;
}

/** Rotate a ring to start at its lowest-then-leftmost point. */
function rotation(ring: readonly Point2[]): number {
  let best = 0;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i] as Point2;
    const q = ring[best] as Point2;
    if (p[1] < q[1] || (p[1] === q[1] && p[0] < q[0])) best = i;
  }
  return best;
}

function rotated<T>(items: readonly T[], at: number): T[] {
  return [...items.slice(at), ...items.slice(0, at)];
}

/** Group traced rings into shapes: holes join the smallest outline around them. */
function assemble(
  rings: readonly TracedRing[],
): Result<{ region: Shape2[]; provenance: EdgeProvenance[] }, ModelingError> {
  const outers = rings.filter((r) => r.area > 0).sort((a, b) => a.area - b.area);
  const holes = rings.filter((r) => r.area < 0);
  const members = outers.map(() => [] as TracedRing[]);
  for (const hole of holes) {
    // A point just inside the material beside the hole's longest edge.
    let longest = 0;
    let longestLen = -1;
    for (let i = 0; i < hole.points.length; i++) {
      const a = hole.points[i] as Point2;
      const b = hole.points[(i + 1) % hole.points.length] as Point2;
      const len = (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]);
      if (len > longestLen) {
        longestLen = len;
        longest = i;
      }
    }
    const a = hole.points[longest] as Point2;
    const b = hole.points[(longest + 1) % hole.points.length] as Point2;
    const len = Math.sqrt(longestLen);
    const eps = len * 1e-6;
    const probe: Point2 = [
      (a[0] + b[0]) / 2 - ((b[1] - a[1]) / len) * eps,
      (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * eps,
    ];
    const owner = outers.findIndex((o) => ringContains(o.points, probe));
    if (owner < 0) {
      return err(
        modelingError('model-degenerate', 'every hole of the result lies inside an outline', {
          hole: [a, b],
        }),
      );
    }
    (members[owner] as TracedRing[]).push(hole);
  }
  const shapes = outers.map((outer, i) => {
    const ringsOf = [
      outer,
      ...(members[i] as TracedRing[]).sort((x, y) => {
        const px = x.points[rotation(x.points)] as Point2;
        const py = y.points[rotation(y.points)] as Point2;
        return px[1] - py[1] || px[0] - py[0];
      }),
    ].map((r) => {
      const at = rotation(r.points);
      return { points: rotated(r.points, at), sources: rotated(r.sources, at) };
    });
    return ringsOf;
  });
  shapes.sort((x, y) => {
    const px = (x[0] as { points: Point2[] }).points[0] as Point2;
    const py = (y[0] as { points: Point2[] }).points[0] as Point2;
    return px[1] - py[1] || px[0] - py[0];
  });
  const region: Shape2[] = [];
  const provenance: EdgeProvenance[] = [];
  for (const shape of shapes) {
    const [outer, ...holeRings] = shape as [
      { points: Point2[]; sources: Piece[] },
      ...{ points: Point2[]; sources: Piece[] }[],
    ];
    region.push(
      holeRings.length === 0
        ? { outer: outer.points }
        : { outer: outer.points, holes: holeRings.map((h) => h.points) },
    );
    for (const r of shape) {
      provenance.push({
        operand: Uint8Array.from(r.sources, (s) => s.operand),
        ring: Int32Array.from(r.sources, (s) => s.ring),
        edge: Int32Array.from(r.sources, (s) => s.edge),
      });
    }
  }
  return ok({ region, provenance });
}

// ---- offset and stroke --------------------------------------------------------------

/** Arc points from angle `a0` sweeping `sweep` (signed) about `c`, exclusive of both ends. */
function arcBetween(
  c: Point2,
  radius: number,
  a0: number,
  sweep: number,
  chord: number,
  out: Point2[],
): void {
  const ratio = Math.min(1, chord / radius);
  const step = 2 * atan2(Math.sqrt(ratio * (2 - ratio)), 1 - ratio);
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / step));
  for (let k = 1; k < n; k++) {
    const t = a0 + (sweep * k) / n;
    out.push([c[0] + radius * cos(t), c[1] + radius * sin(t)]);
  }
}

/**
 * Raw offset ring: every edge moved `delta` to its right, with
 * a join where neighbouring offsets diverge and a detour through the corner where they
 * overlap; the positive fill of the arrangement removes the overlaps. `edges[k]` is the
 * source edge of segment k (-1 for joins and caps).
 */
function rawOffset(
  ring: readonly Point2[],
  delta: number,
  params: RegionJobParams,
): { points: Point2[]; edges: number[] } {
  const n = ring.length;
  const points: Point2[] = [];
  const edges: number[] = [];
  const push = (p: Point2, edge: number) => {
    points.push(p);
    edges.push(edge);
  };
  const normal = (i: number): Point2 => {
    const a = ring[i % n] as Point2;
    const b = ring[(i + 1) % n] as Point2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    return [dy / len, -dx / len];
  };
  const chord = params.arcTolerance ?? Math.abs(delta) * 0.005;
  const r = Math.abs(delta);
  const sign = delta > 0 ? 1 : -1;
  const limit = params.miterLimit ?? 2;
  for (let i = 0; i < n; i++) {
    const prev = normal(i + n - 1);
    const next = normal(i);
    const p = ring[i] as Point2;
    const from: Point2 = [p[0] + prev[0] * delta, p[1] + prev[1] * delta];
    const to: Point2 = [p[0] + next[0] * delta, p[1] + next[1] * delta];
    // Edge directions are the normals turned left, so their cross product is the normals'.
    const cross = prev[0] * next[1] - prev[1] * next[0];
    const dot = prev[0] * next[0] + prev[1] * next[1];
    const cap = cross === 0 && dot < 0;
    push(from, -1);
    if (!cap && cross * delta <= 0) {
      if (cross !== 0) push(p, -1);
    } else {
      const style = cap ? (params.cap ?? 'round') : (params.join ?? 'round');
      if (style === 'round') {
        const a0 = atan2(prev[1] * sign, prev[0] * sign);
        let sweep = cap ? sign * PI : atan2(next[1] * sign, next[0] * sign) - a0;
        while (sweep > PI) sweep -= 2 * PI;
        while (sweep < -PI) sweep += 2 * PI;
        const before = points.length;
        arcBetween(p, r, a0, sweep, chord, points);
        for (let k = before; k < points.length; k++) edges.push(-1);
      } else if (style === 'square') {
        const d: Point2 = [-prev[1], prev[0]];
        push([from[0] + d[0] * r, from[1] + d[1] * r], -1);
        push([to[0] + d[0] * r, to[1] + d[1] * r], -1);
      } else if (style === 'miter' && 2 / (1 + dot) <= limit * limit) {
        const k = delta / (1 + dot);
        push([p[0] + (prev[0] + next[0]) * k, p[1] + (prev[1] + next[1]) * k], -1);
      }
    }
    push(to, i);
  }
  return { points, edges };
}

function offsetSources(
  rings: readonly Point2[][],
  params: RegionJobParams,
  open: boolean,
): Segment[] {
  const delta = params.delta ?? 0;
  const segments: Segment[] = [];
  for (const [r, ring] of rings.entries()) {
    const n = ring.length;
    const closed = open ? [...ring, ...ring.slice(1, -1).reverse()] : ring;
    if (closed.length < 2) continue;
    const raw = rawOffset(closed, open ? Math.abs(delta) : delta, params);
    const m = raw.points.length;
    for (let i = 0; i < m; i++) {
      const a = raw.points[i] as Point2;
      const b = raw.points[(i + 1) % m] as Point2;
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const e = raw.edges[i] as number;
      const edge = !open || e < n - 1 ? e : 2 * n - 3 - e;
      segments.push({ a, b, operand: 0, ring: r, edge });
    }
  }
  return segments;
}

/** Open polylines from region bytes: each shape outline is one polyline, holes unused. */
function polylines(region: Region2): Point2[][] {
  return region.map((shape) => {
    const out: Point2[] = [];
    for (const p of shape.outer) {
      const last = out[out.length - 1];
      if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    return out;
  });
}

function requireRegionParams(params: RegionJobParams): Result<void, ModelingError> {
  if (!Number.isFinite(params.tolerance) || params.tolerance <= 0) {
    return err(
      modelingError('model-invalid-argument', 'tolerance is a finite length > 0', {
        tolerance: params.tolerance,
      }),
    );
  }
  if (params.operation === 'offset' || params.operation === 'stroke') {
    const delta = params.delta;
    if (delta === undefined || !Number.isFinite(delta)) {
      return err(modelingError('model-invalid-argument', 'delta is a finite length', { delta }));
    }
    if (params.operation === 'stroke' && delta <= 0) {
      return err(modelingError('model-invalid-argument', 'a stroke half-width is > 0', { delta }));
    }
    const chord = params.arcTolerance;
    if (chord !== undefined && (!Number.isFinite(chord) || chord <= 0)) {
      return err(
        modelingError('model-invalid-argument', 'arcTolerance is a finite length > 0', {
          arcTolerance: chord,
        }),
      );
    }
    const limit = params.miterLimit;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return err(
        modelingError('model-invalid-argument', 'miterLimit is a finite ratio >= 1', {
          miterLimit: limit,
        }),
      );
    }
  }
  return ok(undefined);
}

export function runRegion(
  request: ComputeJobRequest<'region'>,
  work: WorkMeter,
): Result<BackendOutput<'region'>, ModelingError> {
  const params = request.params;
  const checked = requireRegionParams(params);
  if (!checked.ok) return checked;
  const binary = params.operation !== 'offset' && params.operation !== 'stroke';
  if (request.inputs.length !== (binary ? 2 : 1)) {
    return err(
      modelingError(
        'model-invalid-argument',
        `the ${params.operation} job has ${binary ? 2 : 1} input region(s)`,
        { inputs: request.inputs.length },
      ),
    );
  }
  const regions: Region2[] = [];
  for (const bytes of request.inputs) {
    const decoded = decodeRegion(bytes);
    if (!decoded.ok) return decoded;
    for (const shape of decoded.value) {
      for (const ring of [shape.outer, ...(shape.holes ?? [])]) {
        for (const p of ring) {
          if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
            return err(
              modelingError('model-invalid-argument', 'region points are finite', { point: p }),
            );
          }
        }
      }
    }
    regions.push(decoded.value);
  }
  let segments: Segment[] = [];
  if (params.operation === 'stroke') {
    segments = offsetSources(polylines(regions[0] as Region2), params, true);
  } else if (params.operation === 'offset') {
    const rings = normalizedRings(regions[0] as Region2).filter((r) => r.length > 0);
    segments = (params.delta as number) === 0 ? [] : offsetSources(rings, params, false);
    if ((params.delta as number) === 0) ringSegments({ rings, operand: 0 }, segments);
  } else {
    for (const [operand, region] of regions.entries()) {
      const rings = normalizedRings(region);
      ringSegments({ rings, operand }, segments);
    }
  }
  const arrangement = arrange(segments, params.tolerance, work);
  if (!arrangement.ok) return arrangement;
  const directed = classify(
    arrangement.value,
    binary ? 2 : 1,
    insideFor(params.operation),
    params.tolerance,
    work,
  );
  if (!directed.ok) return directed;
  const assembled = assemble(trace(arrangement.value.points, directed.value));
  if (!assembled.ok) return assembled;
  return ok({
    status: 'ok',
    outputs: [encodeRegion(assembled.value.region)],
    provenance: assembled.value.provenance,
    metrics: {
      segments: segments.length,
      intersections: arrangement.value.intersections,
      vertices: arrangement.value.points.length,
      edges: directed.value.length,
      shapes: assembled.value.region.length,
    },
    locations: [],
  });
}
