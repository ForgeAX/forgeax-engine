import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, pushAll } from '../arrays';
import { faceLoops } from './faces';
import { patchQuads, sampleLine, splitTriangle, type TriHost } from './quad-tri';
import type { Coedge, Curve, Edge, Face, Shape, Surface } from './types';
import { add3, cross3, dist3, dot3, len3, type P3, scale3, sub3, unit3 } from './vec';

/**
 * Planar faces whose outer loop is a rounded rectangle: four straight sides alternating with four corner runs (chord
 * polylines or arcs), no hole. The face splits into a core rectangle, four side strips and four quarter-disc corner
 * triangles; the cut lines are interior, so only the strip widths are free and they absorb every parity and
 * proportion constraint the corner arcs impose. Each corner triangle has the arc and its two spokes as sides and takes
 * the three-quad centre split; strips and core are transfinite grids.
 */

type Step<T> = Result<T, string>;

const AXIS_TOL = 1e-9;
const STRAIGHT_TOL = 1e-6;
const MAX_WIDTH = 160;

export interface RoundRect {
  /** Coedge ids of side k, loop order; the straight run between corner k-1 and corner k. */
  readonly sides: readonly (readonly number[])[];
  /** Coedge ids of corner k: the run from the end of side k to the start of side k+1. */
  readonly corners: readonly (readonly number[])[];
}

function endpoints(shape: Shape, c: number): [P3, P3] {
  const co = shape.coedges[c] as Coedge;
  const e = shape.edges[co.edge] as Edge;
  const a = (shape.vertices[co.reversed ? e.v1 : e.v0] as { p: P3 }).p;
  const b = (shape.vertices[co.reversed ? e.v0 : e.v1] as { p: P3 }).p;
  return [a, b];
}

function isLineCoedge(shape: Shape, c: number): boolean {
  const e = shape.edges[(shape.coedges[c] as Coedge).edge] as Edge;
  return e.curve >= 0 && (shape.curves[e.curve] as Curve).kind === 'line';
}

/** The four sides and corners of a holeless planar face that is a rounded rectangle, or undefined. */
export function roundRectOf(shape: Shape, f: number): RoundRect | undefined {
  const surface = shape.surfaces[(shape.faces[f] as Face).surface] as Surface;
  if (surface.kind !== 'plane') return undefined;
  const { outer, holes } = faceLoops(shape, f);
  const n = outer.length;
  if (holes.length > 0 || n < 8) return undefined;
  const normal = unit3(surface.frame.z);
  const dirs = outer.map((c) => {
    const [a, b] = endpoints(shape, c);
    return sub3(b, a);
  });
  let longest = -1;
  let best = 0;
  outer.forEach((c, i) => {
    const l = len3(dirs[i] as P3);
    if (isLineCoedge(shape, c) && l > best) {
      best = l;
      longest = i;
    }
  });
  if (longest < 0) return undefined;
  const d0 = unit3(dirs[longest] as P3);
  const perp = cross3(normal, d0);
  // With arc corners the sides are the line runs and need no axis; otherwise they are the axis-aligned runs.
  const arcs = outer.some((c) => !isLineCoedge(shape, c));
  // Axis class of a coedge: 0 +d0, 1 +perp, 2 -d0, 3 -perp, or -1 for a corner coedge.
  const cls = outer.map((c, i) => {
    const d = dirs[i] as P3;
    const l = len3(d);
    if (!isLineCoedge(shape, c) || l === 0) return -1;
    if (arcs) return 0;
    const x = dot3(d, d0) / l;
    const y = dot3(d, perp) / l;
    if (Math.abs(y) <= AXIS_TOL) return x > 0 ? 0 : 2;
    if (Math.abs(x) <= AXIS_TOL) return y > 0 ? 1 : 3;
    return -1;
  });
  const first = cls.findIndex((c, i) => c >= 0 && cls[(i + n - 1) % n] !== c);
  if (first < 0) return undefined;
  const sides: number[][] = [];
  const corners: number[][] = [];
  const classes: number[] = [];
  let i = 0;
  while (i < n) {
    const at = (first + i) % n;
    const c = cls[at] as number;
    const run: number[] = [];
    if (c >= 0) {
      while (i < n && cls[(first + i) % n] === c) run.push(outer[(first + i++) % n] as number);
      if (sides.length > corners.length) return undefined;
      sides.push(run);
      classes.push(c);
    } else {
      while (i < n && cls[(first + i) % n] === -1) run.push(outer[(first + i++) % n] as number);
      if (corners.length >= sides.length) return undefined;
      corners.push(run);
    }
  }
  if (sides.length !== 4 || corners.length !== 4) return undefined;
  if (!arcs && classes.some((c, k) => c !== ((classes[0] as number) + k) % 4)) return undefined;
  if (arcs && !straightSides(shape, sides, outer)) return undefined;
  const result: RoundRect = { sides, corners };
  return cornerFrames(shape, result, normal) === undefined ? undefined : result;
}

function dirOf(shape: Shape, c: number): P3 {
  const [a, b] = endpoints(shape, c);
  return sub3(b, a);
}

/** Every side run is one straight direction, and every corner coedge is a circle. */
function straightSides(
  shape: Shape,
  sides: readonly (readonly number[])[],
  outer: readonly number[],
): boolean {
  for (const run of sides) {
    const d0 = unit3(dirOf(shape, run[0] as number));
    for (const c of run) {
      const d = dirOf(shape, c);
      if (len3(cross3(unit3(d), d0)) > STRAIGHT_TOL || dot3(d, d0) <= 0) return false;
    }
  }
  return outer.every((c) => {
    const e = shape.edges[(shape.coedges[c] as Coedge).edge] as Edge;
    return isLineCoedge(shape, c) || (shape.curves[e.curve] as Curve).kind === 'circle';
  });
}

interface Frame4 {
  /** Side directions, unit. */
  readonly u: readonly P3[];
  /** Inner corner points: the quarter-disc centres. */
  readonly q: readonly P3[];
  /** Spoke lengths: `a[k]` of corner k-1 toward the start of side k, `b[k]` of corner k toward the end of side k. */
  readonly a: readonly number[];
  readonly b: readonly number[];
}

/** Side directions and inner corner points when the loop turns left at every corner and each corner box has area. */
function cornerFrames(shape: Shape, rr: RoundRect, normal: P3): Frame4 | undefined {
  const start = rr.sides.map((s) => endpoints(shape, s[0] as number)[0]);
  const end = rr.sides.map((s) => endpoints(shape, s[s.length - 1] as number)[1]);
  const u = rr.sides.map((_, k) => unit3(sub3(end[k] as P3, start[k] as P3)));
  const q: P3[] = [];
  const a: number[] = [0, 0, 0, 0];
  const b: number[] = [0, 0, 0, 0];
  const arcs = rr.corners.some((run) => run.some((c) => !isLineCoedge(shape, c)));
  for (let k = 0; k < 4; k++) {
    const next = (k + 1) % 4;
    const uk = u[k] as P3;
    const un = u[next] as P3;
    if (dot3(cross3(uk, un), normal) <= 0) return undefined;
    if (arcs) {
      // Fillet arc: its centre is the inner corner, one radius inward from both side ends along their normals.
      const nk = cross3(normal, uk);
      const nn = cross3(normal, un);
      const dn = sub3(nk, nn);
      const radius = dot3(sub3(start[next] as P3, end[k] as P3), dn) / dot3(dn, dn);
      const centre = add3(end[k] as P3, scale3(nk, radius));
      const other = add3(start[next] as P3, scale3(nn, radius));
      if (radius <= 0 || dist3(centre, other) > STRAIGHT_TOL) return undefined;
      q.push(centre);
      a[next] = radius;
      b[k] = radius;
      continue;
    }
    const gap = sub3(start[next] as P3, end[k] as P3);
    const along = dot3(gap, uk);
    const inward = dot3(gap, un);
    if (along <= 0 || inward <= 0) return undefined;
    q.push(add3(end[k] as P3, scale3(un, inward)));
    a[next] = along;
    b[k] = inward;
  }
  return { u, q, a, b };
}

/** Opposite straight sides that are single edges must share their sample count; the count owner pairs them. */
export function roundRectPairs(shape: Shape): [number, number][] {
  const pairs: [number, number][] = [];
  for (let f = 0; f < shape.faces.length; f++) {
    const rr = roundRectOf(shape, f);
    if (rr === undefined) continue;
    for (const k of [0, 1] as const) {
      const s0 = rr.sides[k] as number[];
      const s1 = rr.sides[k + 2] as number[];
      if (s0.length !== 1 || s1.length !== 1) continue;
      const e0 = (shape.coedges[s0[0] as number] as Coedge).edge;
      const e1 = (shape.coedges[s1[0] as number] as Coedge).edge;
      if (e0 !== e1) pairs.push([e0, e1]);
    }
  }
  return pairs;
}

/** Corner arc edges of arc-cornered faces: a one-sample arc cannot close a centre-split triangle, so they take two. */
export function roundRectArcEdges(shape: Shape): number[] {
  const out: number[] = [];
  for (let f = 0; f < shape.faces.length; f++) {
    const rr = roundRectOf(shape, f);
    if (rr === undefined) continue;
    for (const run of rr.corners)
      for (const c of run) if (!isLineCoedge(shape, c)) out.push((shape.coedges[c] as Coedge).edge);
  }
  return out;
}

export interface RoundHost extends TriHost {
  readonly size: number;
}

function sq(x: number): number {
  return x * x;
}

function feasible(arc: number, w0: number, w1: number): boolean {
  return (arc + w0 + w1) % 2 === 0 && w0 + w1 >= arc + 2 && Math.abs(w0 - w1) <= arc - 2;
}

/**
 * Strip widths (sample counts of the cut spokes) closest to the natural width such that every corner triangle fits
 * the centre split; undefined when none exists below the cap. Corner k joins widths k and k+1.
 */
function stripWidths(arcs: readonly number[], ideal: readonly number[]): number[] | undefined {
  const top = Math.min(MAX_WIDTH, maxOf(arcs) + 6);
  let bestCost = Infinity;
  let best: number[] | undefined;
  for (let w0 = 1; w0 <= top; w0++) {
    // cost[k][w] = least squared deviation of widths 0..k with width k = w; from[k][w] = width k-1 on that path.
    let cost: number[] = new Array(top + 1).fill(Infinity);
    cost[w0] = sq(w0 - (ideal[0] as number));
    const from: number[][] = [[]];
    for (let k = 1; k < 4; k++) {
      const next: number[] = new Array(top + 1).fill(Infinity);
      const back: number[] = new Array(top + 1).fill(0);
      for (let w = 1; w <= top; w++) {
        for (let p = 1; p <= top; p++) {
          if ((cost[p] as number) === Infinity || !feasible(arcs[k - 1] as number, p, w)) continue;
          const c = (cost[p] as number) + sq(w - (ideal[k] as number));
          if (c < (next[w] as number)) {
            next[w] = c;
            back[w] = p;
          }
        }
      }
      cost = next;
      from.push(back);
    }
    for (let w = 1; w <= top; w++) {
      if ((cost[w] as number) === Infinity || !feasible(arcs[3] as number, w, w0)) continue;
      if ((cost[w] as number) < bestCost) {
        bestCost = cost[w] as number;
        const path = [w];
        for (let k = 3; k > 0; k--)
          path.unshift((from[k] as number[])[path[0] as number] as number);
        best = path;
      }
    }
  }
  return best;
}

/** Quads of one rounded-rectangle face wound with its outline, or an error when its counts do not fit. */
export function roundRectQuads(host: RoundHost, f: number): Step<number[][]> {
  const { shape } = host;
  const rr = roundRectOf(shape, f);
  if (rr === undefined) return err('rrect-shape');
  const frame = cornerFrames(
    shape,
    rr,
    unit3(
      (shape.surfaces[(shape.faces[f] as Face).surface] as Extract<Surface, { kind: 'plane' }>)
        .frame.z,
    ),
  );
  if (frame === undefined) return err('rrect-shape');
  const runOf = (cs: readonly number[]): Step<number[]> => {
    const ids: number[] = [];
    for (const c of cs) {
      const sampled = host.edgeSamples((shape.coedges[c] as Coedge).edge);
      if (!sampled.ok) return sampled;
      const oriented = (shape.coedges[c] as Coedge).reversed
        ? sampled.value.slice().reverse()
        : sampled.value;
      pushAll(ids, ids.length === 0 ? oriented : oriented.slice(1));
    }
    return ok(ids);
  };
  const sides: number[][] = [];
  const arcs: number[][] = [];
  for (let k = 0; k < 4; k++) {
    const s = runOf(rr.sides[k] as number[]);
    if (!s.ok) return s;
    const c = runOf(rr.corners[k] as number[]);
    if (!c.ok) return c;
    sides.push(s.value);
    arcs.push(c.value);
  }
  const n = sides.map((s) => s.length - 1);
  if (n[0] !== n[2] || n[1] !== n[3]) return err('rrect-opposite-counts');
  const arcCounts = arcs.map((a) => a.length - 1);
  const ideal = [0, 1, 2, 3].map((k) =>
    Math.max(1, Math.round(((frame.b[k] as number) + (frame.a[k] as number)) / 2 / host.size)),
  );
  const w = stripWidths(arcCounts, ideal);
  if (w === undefined) return err('rrect-strip-widths');
  const q = frame.q.map((p) => host.vertex(p));
  const startOf = (k: number) => (sides[k] as number[])[0] as number;
  const endOf = (k: number) => (sides[k] as number[])[(sides[k] as number[]).length - 1] as number;
  // Cut spokes from a side end inward to the shared inner corner: aLine[k] at the start of side k, eLine[k] at its end.
  const aLine = [0, 1, 2, 3].map((k) =>
    sampleLine(host, startOf(k), q[(k + 3) % 4] as number, w[k] as number),
  );
  const eLine = [0, 1, 2, 3].map((k) => sampleLine(host, endOf(k), q[k] as number, w[k] as number));
  // Inner cut lines: core side k runs from inner corner k-1 to inner corner k, parallel to side k.
  const inner = [0, 1, 2, 3].map((k) =>
    sampleLine(host, q[(k + 3) % 4] as number, q[k] as number, n[k] as number),
  );
  const quads: number[][] = [];
  const push = (patch: Step<number[][]>): Step<number[][]> | undefined => {
    if (!patch.ok) return patch;
    pushAll(quads, patch.value);
    return undefined;
  };
  for (let k = 0; k < 4; k++) {
    const strip = push(
      patchQuads(
        host,
        sides[k] as number[],
        eLine[k] as number[],
        inner[k] as number[],
        aLine[k] as number[],
      ),
    );
    if (strip !== undefined) return strip;
    const corner = push(
      splitTriangle(host, [
        arcs[k] as number[],
        aLine[(k + 1) % 4] as number[],
        (eLine[k] as number[]).slice().reverse(),
      ]),
    );
    if (corner !== undefined) return corner;
  }
  const core = push(
    patchQuads(
      host,
      inner[0] as number[],
      inner[1] as number[],
      (inner[2] as number[]).slice().reverse(),
      (inner[3] as number[]).slice().reverse(),
    ),
  );
  if (core !== undefined) return core;
  return ok(quads);
}
