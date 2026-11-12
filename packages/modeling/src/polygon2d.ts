import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import { orient2d } from './predicates';

type P2 = readonly [number, number];

function turn(points: readonly P2[], a: number, b: number, c: number): number {
  const pa = points[a] as P2;
  const pb = points[b] as P2;
  const pc = points[c] as P2;
  return orient2d(pa[0], pa[1], pb[0], pb[1], pc[0], pc[1]);
}

/** Inclusive point-in-triangle test for a counter-clockwise triangle. */
function inTriangle(points: readonly P2[], a: number, b: number, c: number, p: number): boolean {
  return turn(points, a, b, p) >= 0 && turn(points, b, c, p) >= 0 && turn(points, c, a, p) >= 0;
}

/**
 * Splice every hole into the outer ring through a mutually visible bridge (the
 * earcut construction): holes in decreasing order of their rightmost x connect from
 * that vertex along +x to the nearest visible ring vertex. Bridge ends appear twice.
 */
function bridgeHoles(
  points: readonly P2[],
  outer: readonly number[],
  holes: readonly (readonly number[])[],
): Result<number[], ModelingError> {
  let ring = [...outer];
  const rightmost = (hole: readonly number[]) => {
    let best = 0;
    for (let i = 1; i < hole.length; i++) {
      const p = points[hole[i] as number] as P2;
      const q = points[hole[best] as number] as P2;
      if (p[0] > q[0] || (p[0] === q[0] && p[1] < q[1])) best = i;
    }
    return best;
  };
  const order = holes
    .map((hole, i) => ({ hole, i, at: rightmost(hole) }))
    .sort((a, b) => {
      const pa = points[a.hole[a.at] as number] as P2;
      const pb = points[b.hole[b.at] as number] as P2;
      return pb[0] - pa[0] || a.i - b.i;
    });
  for (const { hole, at } of order) {
    const m = hole[at] as number;
    const [mx, my] = points[m] as P2;
    let bestX = Infinity;
    let candidate = -1;
    for (let i = 0; i < ring.length; i++) {
      const a = points[ring[i] as number] as P2;
      const b = points[ring[(i + 1) % ring.length] as number] as P2;
      if (a[1] === b[1] || my < Math.min(a[1], b[1]) || my > Math.max(a[1], b[1])) continue;
      const x = a[0] + ((my - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x <= mx || x >= bestX) continue;
      bestX = x;
      candidate = a[0] >= b[0] ? i : (i + 1) % ring.length;
    }
    if (candidate < 0) {
      return err(modelingError('model-degenerate', 'every hole sees the outline', { hole: at }));
    }
    // A reflex ring vertex inside the triangle (M, I, P) can hide P; take the one closest in angle.
    const p = points[ring[candidate] as number] as P2;
    const triangle =
      my < p[1] ? ([[mx, my], [bestX, my], p] as const) : ([[mx, my], p, [bestX, my]] as const);
    const inside = (q: P2) => {
      const o = (u: P2, v: P2) => orient2d(u[0], u[1], v[0], v[1], q[0], q[1]);
      return (
        o(triangle[0], triangle[1]) >= 0 &&
        o(triangle[1], triangle[2]) >= 0 &&
        o(triangle[2], triangle[0]) >= 0
      );
    };
    let bestTan = Infinity;
    let chosen = candidate;
    for (let i = 0; i < ring.length; i++) {
      if (i === candidate) continue;
      const q = points[ring[i] as number] as P2;
      if (q[0] < mx || q[0] > p[0] || (q[0] === p[0] && q[1] === p[1]) || !inside(q)) continue;
      const prev = ring[(i + ring.length - 1) % ring.length] as number;
      const next = ring[(i + 1) % ring.length] as number;
      if (turn(points, prev, ring[i] as number, next) >= 0) continue;
      const tan = Math.abs(my - q[1]) / (q[0] - mx || Number.MIN_VALUE);
      if (tan < bestTan || (tan === bestTan && q[0] > (points[ring[chosen] as number] as P2)[0])) {
        bestTan = tan;
        chosen = i;
      }
    }
    // Radially aligned holes put other vertices exactly on the ray, where the candidate
    // can be hidden or entered from outside its sector; then bridge to the nearest vertex
    // that is visible and locally inside instead.
    if (!bridgeable(points, ring, chosen, m, holes)) {
      const order = ring
        .map((v, i) => {
          const q = points[v] as P2;
          return { i, d: (q[0] - mx) * (q[0] - mx) + (q[1] - my) * (q[1] - my) };
        })
        .sort((a, b) => a.d - b.d || a.i - b.i);
      const found = order.find(({ i }) => bridgeable(points, ring, i, m, holes));
      if (found === undefined) {
        return err(modelingError('model-degenerate', 'every hole sees the outline', { hole: at }));
      }
      chosen = found.i;
    }
    const loop: number[] = [];
    for (let k = 0; k <= hole.length; k++) loop.push(hole[(at + k) % hole.length] as number);
    ring = [
      ...ring.slice(0, chosen + 1),
      ...loop,
      ring[chosen] as number,
      ...ring.slice(chosen + 1),
    ];
  }
  return ok(ring);
}

/** Segments ab and cd share a point (touching and collinear overlap included). */
function segmentsMeet(a: P2, b: P2, c: P2, d: P2): boolean {
  const o1 = orient2d(a[0], a[1], b[0], b[1], c[0], c[1]);
  const o2 = orient2d(a[0], a[1], b[0], b[1], d[0], d[1]);
  const o3 = orient2d(c[0], c[1], d[0], d[1], a[0], a[1]);
  const o4 = orient2d(c[0], c[1], d[0], d[1], b[0], b[1]);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  const on = (p: P2, q: P2, r: P2) =>
    Math.min(p[0], q[0]) <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] &&
    r[1] <= Math.max(p[1], q[1]);
  return (
    (o1 === 0 && on(a, b, c)) ||
    (o2 === 0 && on(a, b, d)) ||
    (o3 === 0 && on(c, d, a)) ||
    (o4 === 0 && on(c, d, b))
  );
}

/**
 * A bridge from hole vertex `m` to ring position `i` keeps the ring weakly simple: it
 * meets no ring or hole edge away from its two ends and leaves ring vertex `i` into the
 * interior sector between its ring edges.
 */
function bridgeable(
  points: readonly P2[],
  ring: readonly number[],
  i: number,
  m: number,
  holes: readonly (readonly number[])[],
): boolean {
  const n = ring.length;
  const q = ring[i] as number;
  const prev = ring[(i + n - 1) % n] as number;
  const next = ring[(i + 1) % n] as number;
  const left = (a: number, b: number) => turn(points, a, b, m) > 0;
  const inside =
    turn(points, prev, q, next) > 0
      ? left(prev, q) && left(q, next)
      : left(prev, q) || left(q, next);
  if (!inside) return false;
  const pm = points[m] as P2;
  const pq = points[q] as P2;
  const edges: [number, number][] = [];
  for (let k = 0; k < n; k++) edges.push([ring[k] as number, ring[(k + 1) % n] as number]);
  for (const hole of holes) {
    for (let k = 0; k < hole.length; k++)
      edges.push([hole[k] as number, hole[(k + 1) % hole.length] as number]);
  }
  for (const [a, b] of edges) {
    if (a === q || b === q || a === m || b === m) continue;
    if (segmentsMeet(pm, pq, points[a] as P2, points[b] as P2)) return false;
  }
  return true;
}

/**
 * Ear clipping of a weakly simple counter-clockwise ring; only reflex corners can block
 * an ear, so the corners that are not strictly convex are kept in a set, updated at the
 * two neighbors of every clip.
 */
function clipEars(
  points: readonly P2[],
  ring: readonly number[],
): Result<number[][], ModelingError> {
  const n = ring.length;
  const next = Int32Array.from({ length: n }, (_, i) => (i + 1) % n);
  const prev = Int32Array.from({ length: n }, (_, i) => (i + n - 1) % n);
  const id = (i: number) => ring[i] as number;
  const blocking = new Set<number>();
  const classify = (j: number) => {
    if (turn(points, id(prev[j] as number), id(j), id(next[j] as number)) > 0) blocking.delete(j);
    else blocking.add(j);
  };
  for (let j = 0; j < n; j++) classify(j);
  const triangles: number[][] = [];
  let alive = n;
  let i = 0;
  let stalled = 0;
  while (alive > 3) {
    const a = prev[i] as number;
    const c = next[i] as number;
    let ear = turn(points, id(a), id(i), id(c)) > 0;
    if (ear) {
      for (const j of blocking) {
        if (j === a || j === i || j === c) continue;
        const v = id(j);
        if (v === id(a) || v === id(i) || v === id(c)) continue;
        if (inTriangle(points, id(a), id(i), id(c), v)) {
          ear = false;
          break;
        }
      }
    }
    if (ear) {
      triangles.push([id(a), id(i), id(c)]);
      next[a] = c;
      prev[c] = a;
      blocking.delete(i);
      classify(a);
      classify(c);
      alive--;
      stalled = 0;
      i = c;
      continue;
    }
    i = c;
    if (++stalled > alive) {
      return err(
        modelingError('model-degenerate', 'the outline with holes is a simple polygon', {
          remaining: alive,
        }),
      );
    }
  }
  const a = prev[i] as number;
  const c = next[i] as number;
  if (turn(points, id(a), id(i), id(c)) > 0) triangles.push([id(a), id(i), id(c)]);
  return ok(triangles);
}

/**
 * Hertel-Mehlhorn: merge triangles across interior diagonals, longest first, while
 * both diagonal ends stay strictly convex. The pieces are convex, so every one is a
 * simple face that export triangulates without overlap.
 */
function mergeConvex(points: readonly P2[], triangles: readonly number[][]): number[][] {
  const polygons: (number[] | undefined)[] = triangles.map((t) => [...t]);
  const owner = new Map<string, number>();
  const key = (u: number, v: number) => `${u},${v}`;
  for (const [p, loop] of polygons.entries()) {
    for (let k = 0; k < (loop as number[]).length; k++) {
      const loopK = loop as number[];
      owner.set(key(loopK[k] as number, loopK[(k + 1) % loopK.length] as number), p);
    }
  }
  const diagonals: { u: number; v: number; length: number }[] = [];
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const u = t[k] as number;
      const v = t[(k + 1) % 3] as number;
      if (u < v && owner.has(key(v, u))) {
        const pu = points[u] as P2;
        const pv = points[v] as P2;
        const dx = pu[0] - pv[0];
        const dy = pu[1] - pv[1];
        diagonals.push({ u, v, length: dx * dx + dy * dy });
      }
    }
  }
  diagonals.sort((x, y) => y.length - x.length || x.u - y.u || x.v - y.v);
  for (const { u, v } of diagonals) {
    const pa = owner.get(key(u, v));
    const pb = owner.get(key(v, u));
    if (pa === undefined || pb === undefined || pa === pb) continue;
    const a = polygons[pa] as number[];
    const b = polygons[pb] as number[];
    const ia = a.indexOf(v);
    const ib = b.indexOf(u);
    const fromA = [...a.slice(ia), ...a.slice(0, ia)];
    const fromB = [...b.slice(ib), ...b.slice(0, ib)];
    const merged = [...fromA, ...fromB.slice(1, -1)];
    const m = merged.length;
    const at = (k: number) => merged[(k + m) % m] as number;
    const iu = fromA.length - 1;
    if (turn(points, at(iu - 1), at(iu), at(iu + 1)) <= 0) continue;
    if (turn(points, at(-1), at(0), at(1)) <= 0) continue;
    polygons[pa] = merged;
    polygons[pb] = undefined;
    owner.delete(key(u, v));
    owner.delete(key(v, u));
    for (let k = 0; k < m; k++) owner.set(key(at(k), at(k + 1)), pa);
  }
  return polygons.filter((p): p is number[] => p !== undefined);
}

/**
 * Convex faces covering an outline with holes. `points` holds the outline
 * (counter-clockwise) followed by each hole (clockwise); returned loops are point
 * indices, counter-clockwise. Every outline and hole edge appears in exactly one loop.
 */
export function convexPartition(
  points: readonly P2[],
  outer: readonly number[],
  holes: readonly (readonly number[])[],
): Result<number[][], ModelingError> {
  const ring = bridgeHoles(points, outer, holes);
  if (!ring.ok) return ring;
  const triangles = clipEars(points, ring.value);
  if (!triangles.ok) return triangles;
  // Nearly collinear ears (vertices of aligned holes one ulp apart) leave zero-area
  // slivers that no merge keeps convex; flip them away first. Inputs without slivers
  // keep their partition unchanged.
  let size = 0;
  for (const p of points) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]));
  const sliver = (t: readonly number[]) =>
    Math.abs(turn(points, t[0] as number, t[1] as number, t[2] as number)) <= 1e-12 * size * size;
  const clean = triangles.value.some(sliver)
    ? delaunayFlips(points, triangles.value, [1, 1])
    : triangles.value;
  return ok(mergeConvex(points, clean));
}

/** Positive when d lies inside the circumcircle of the counter-clockwise triangle a, b, c. */
function inCircle(a: P2, b: P2, c: P2, d: P2): number {
  const adx = a[0] - d[0];
  const ady = a[1] - d[1];
  const bdx = b[0] - d[0];
  const bdy = b[1] - d[1];
  const cdx = c[0] - d[0];
  const cdy = c[1] - d[1];
  const ad = adx * adx + ady * ady;
  const bd = bdx * bdx + bdy * bdy;
  const cd = cdx * cdx + cdy * cdy;
  return adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx);
}

/**
 * Lawson flips toward the constrained Delaunay triangulation: interior edges whose
 * opposite vertex lies inside a circumcircle are flipped (boundary edges stay), which
 * removes the slivers ear clipping leaves. `metric` scales the coordinates first.
 */
function delaunayFlips(points: readonly P2[], triangles: number[][], metric: P2): number[][] {
  const q = points.map((p): P2 => [p[0] * metric[0], p[1] * metric[1]]);
  const tris = triangles.map((t) => [...t]);
  const owner = new Map<string, number>();
  const key = (a: number, b: number) => `${a},${b}`;
  const index = (i: number) => {
    const t = tris[i] as number[];
    for (let k = 0; k < 3; k++) owner.set(key(t[k] as number, t[(k + 1) % 3] as number), i);
  };
  for (let i = 0; i < tris.length; i++) index(i);
  const scale = Math.max(1e-300, ...q.map((p) => Math.abs(p[0]) + Math.abs(p[1])));
  const eps = 1e-12 * scale * scale * scale * scale;
  let changed = true;
  for (let pass = 0; changed && pass < 4 * tris.length + 8; pass++) {
    changed = false;
    for (let i = 0; i < tris.length; i++) {
      for (let k = 0; k < 3; k++) {
        const t = tris[i] as number[];
        const a = t[k] as number;
        const b = t[(k + 1) % 3] as number;
        const c = t[(k + 2) % 3] as number;
        const j = owner.get(key(b, a));
        if (j === undefined) continue;
        const u = tris[j] as number[];
        const d = u.find((v) => v !== a && v !== b) as number;
        const [pa, pb, pc, pd] = [q[a], q[b], q[c], q[d]] as [P2, P2, P2, P2];
        if (inCircle(pa, pb, pc, pd) <= eps) continue;
        if (orient2d(pc[0], pc[1], pa[0], pa[1], pd[0], pd[1]) <= 0) continue;
        if (orient2d(pd[0], pd[1], pb[0], pb[1], pc[0], pc[1]) <= 0) continue;
        owner.delete(key(a, b));
        owner.delete(key(b, a));
        tris[i] = [c, a, d];
        tris[j] = [d, b, c];
        index(i);
        index(j);
        changed = true;
        break;
      }
    }
  }
  return tris;
}

/**
 * Well-shaped triangles covering an outline with holes (same conventions as
 * `convexPartition`): ear clipping, then Delaunay flips under `metric`.
 */
export function triangulatePolygon(
  points: readonly P2[],
  outer: readonly number[],
  holes: readonly (readonly number[])[],
  metric: P2 = [1, 1],
): Result<number[][], ModelingError> {
  const ring = bridgeHoles(points, outer, holes);
  if (!ring.ok) return ring;
  const triangles = clipEars(points, ring.value);
  if (!triangles.ok) return triangles;
  return ok(delaunayFlips(points, triangles.value, metric));
}
