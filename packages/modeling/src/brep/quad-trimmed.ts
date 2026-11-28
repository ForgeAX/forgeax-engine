import { atan2 } from '../dmath';
import { type MatchEdge, minCostPerfectMatching } from './matching';
import { rowFrontInner } from './quad-row';
import { surfacePoint } from './surfaces';
import { type TrimRing, triangulateTrimmed } from './tessellate-trimmed';
import type { Surface } from './types';
import { cross3, dot3, len3, type P2, type P3, scale3, sub3 } from './vec';

/**
 * All-quad Blossom-Quad for one trimmed face: the trimmed CDT's triangles are paired across shared
 * interior edges by a minimum-cost perfect matching, and each pair becomes one quad. Boundary
 * vertices are the caller's shared ring ids, so neighbouring faces stay conforming. Ring vertex
 * counts must be even (checked), because the triangle count then has the same parity.
 */

export interface TrimmedQuadOptions {
  /** Normal-turn bound forwarded to the trim refiner, in radians. */
  readonly angle: number;
  /** Upper bound on boundary plus interior points. */
  readonly maxPoints: number;
  /** Upper bound on triangles entering the matching; larger faces fail closed. */
  readonly maxTriangles: number;
  /**
   * Opt-in best effort: non-convex pairs stay admissible at a fixed high cost, and each matched fold
   * is split into two quads through one interior vertex on a reflex diagonal. Folds that no split
   * can resolve are emitted as they are and counted in `unresolved`.
   */
  readonly penalty?: boolean;
  /**
   * Opt-in: pair as many convex triangle pairs as possible (a maximum-cardinality matching), and
   * emit every leftover triangle as a triangle. Folds are never admitted and no hole is created;
   * every triangle keeps the shared ring ids, so the face stays conforming. Exclusive with `penalty`.
   */
  readonly dominant?: boolean;
  /** Dominant mode only, opt-in: pairs below the scaled-Jacobian floor stay single triangles. */
  readonly dominantSjFloor?: boolean;
  /**
   * Opt-in: place one layer of quads along every trim ring (shared boundary ids, offset inner ring),
   * then mesh the region inside the inner rings. Fails closed with `row-front-collision` when the
   * offset ring folds, self-intersects or approaches another loop.
   */
  readonly rowFront?: boolean;
  /** Row-front interior only: pairs below the scaled-Jacobian floor stay single triangles. */
  readonly sjFloor?: boolean;
  /**
   * Row-front interior only: one global minimum-cost perfect matching over every convex, flat pair.
   * Pairs below the scaled-Jacobian floor stay admissible at a soft cost (their shortfall below
   * SJ_FLOOR), so the matching covers every triangle and reports the floor afterwards.
   */
  readonly globalMatch?: boolean;
  /**
   * Opt-in, used only when the matching has no perfect solution: every triangle becomes three quads
   * around its centroid (Blossom-Quad fallback, Remacle et al. 2012). Boundary samples are shared ids
   * and are not re-split; the CDT ring uses the even-index samples and the odd ones become its midpoints.
   */
  readonly fallback?: 'split-3';
  /**
   * Opt-in extra cost of one candidate quad (corners in order, 3D), added to the right-angle cost of the
   * matching edge. A guidance term such as field alignment; it never changes which pairs are admissible.
   * Must return a finite number >= 0.
   */
  readonly pairCost?: (corners: readonly P3[]) => number;
  /** Opt-in cap on the interior triangle edge length in metres, forwarded to the trim refiner. */
  readonly spacing?: number;
}

export type TrimmedQuadFailure =
  | { readonly reason: 'odd-ring-count'; readonly count: number }
  | { readonly reason: 'trim-triangulation'; readonly detail: string }
  | { readonly reason: 'matching-too-large'; readonly triangles: number }
  | { readonly reason: 'no-perfect-matching' }
  | { readonly reason: 'bad-matching' }
  | { readonly reason: 'row-front-collision' }
  | { readonly reason: 'split-3-parity' }
  | { readonly reason: 'split-3-fold' };

export interface TrimmedQuads {
  readonly quads: readonly (readonly [number, number, number, number])[];
  readonly triangles: number;
  readonly pairs: number;
  /** Folded pairs replaced by two quads (penalty mode only). */
  readonly folded: number;
  /** Folded pairs no interior split could make convex; emitted unchanged (penalty mode only). */
  readonly unresolved: number;
  /** Triangles left unpaired, emitted as triangles (dominant mode only). */
  readonly singles: readonly (readonly [number, number, number])[];
  /** Trim rings whose web is narrower than two rows; they keep their boundary (row-front mode). */
  readonly rowSkipped: number;
  /** The interior fell back from strict matching to quad-dominant (row-front mode). */
  readonly fallback: boolean;
  /** Interior ids minted by the split-3 fallback (centres and non-ring midpoints); empty otherwise. */
  readonly owned: readonly number[];
  /** The first this many quads are boundary-row quads (row-front mode); the rest are interior. */
  readonly rowQuadCount: number;
  /** Set when the split-3 fallback produced this face's quads (no perfect matching existed). */
  readonly split3: boolean;
}

/** Cost of a non-convex pair in penalty mode: far above any quad cost in [0, 1]. */
const FOLD_PENALTY = 1000;
/**
 * Cost of leaving a triangle single in dominant mode. A quad cost is at most 1, so merging two
 * singles into one pair always lowers the total: the minimum-cost perfect matching then maximises pairs.
 */
const SINGLE_COST = 2;
/**
 * Dominant mode admits a pair only when its smallest corner sine exceeds this floor. A corner whose
 * neighbours are collinear has a sine of rounding size; the strict convexity test alone would pair it.
 */
const FLAT_FLOOR = 1e-6;
/** Dominant-mode admission floor on a pair's scaled Jacobian; below it the triangles stay single. */
const SJ_FLOOR = 0.3;
/** Global-matching cost per unit of scaled-Jacobian shortfall below SJ_FLOOR (soft, not a reject). */
const SJ_SOFT_WEIGHT = 4;

/** Min over corners of the sine of each corner turn about the face normal, unit edges (scaled Jacobian). */
function pairSj(p: readonly P3[], normalRaw: P3): number {
  const nl = len3(normalRaw);
  if (nl === 0) return 0;
  const normal = scale3(normalRaw, 1 / nl);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 4; i++) {
    const here = p[i] as P3;
    const d1 = sub3(p[(i + 1) % 4] as P3, here);
    const d2 = sub3(p[(i + 3) % 4] as P3, here);
    const l1 = len3(d1);
    const l2 = len3(d2);
    if (l1 === 0 || l2 === 0) return 0;
    min = Math.min(min, dot3(cross3(scale3(d1, 1 / l1), scale3(d2, 1 / l2)), normal));
  }
  return min;
}

/** Quad cost: mean deviation of corner angles from a right angle, normalized to [0, 1]. */
function quadCost(p: readonly P3[]): number {
  let dev = 0;
  for (let k = 0; k < 4; k++) {
    const a = p[(k + 3) % 4] as P3;
    const b = p[k] as P3;
    const c = p[(k + 1) % 4] as P3;
    const u = sub3(a, b);
    const v = sub3(c, b);
    const nu = Math.sqrt(dot3(u, u));
    const nv = Math.sqrt(dot3(v, v));
    if (nu === 0 || nv === 0) return 1;
    const cos = Math.max(-1, Math.min(1, dot3(u, v) / (nu * nv)));
    // |acos(cos) - pi/2| = |asin(cos)|; atan2 keeps the dmath (deterministic) path.
    dev += Math.abs(atan2(cos, Math.sqrt(1 - cos * cos)));
  }
  return dev / (4 * (Math.PI / 2));
}

function mid(a: P3, b: P3): P3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** Normal of a counter-clockwise triangle (in the face's uv orientation), from its vertex positions. */
function normalOf(pos: readonly P3[], t: readonly [number, number, number]): P3 {
  const a = pos[t[0]] as P3;
  return cross3(sub3(pos[t[1]] as P3, a), sub3(pos[t[2]] as P3, a));
}

/** True when every corner turns the same way as `normal`, i.e. the quad has no reflex corner. */
function convexAbout(p: readonly P3[], normal: P3): boolean {
  for (let k = 0; k < 4; k++) {
    const prev = p[(k + 3) % 4] as P3;
    const cur = p[k] as P3;
    const next = p[(k + 1) % 4] as P3;
    if (dot3(cross3(sub3(cur, prev), sub3(next, cur)), normal) <= 0) return false;
  }
  return true;
}

/** True when every corner's signed sine about `normal` exceeds `FLAT_FLOOR`. */
function flatSafe(p: readonly P3[], normal: P3): boolean {
  const length = Math.sqrt(dot3(normal, normal));
  if (!(length > 0)) return false;
  const unit: P3 = [normal[0] / length, normal[1] / length, normal[2] / length];
  return turnScore(p, unit) > FLAT_FLOOR;
}

/** Smallest signed sine of a corner turn about `normal`; positive when every corner turns the same way. */
function turnScore(p: readonly P3[], normal: P3): number {
  let worst = Infinity;
  for (let k = 0; k < 4; k++) {
    const prev = p[(k + 3) % 4] as P3;
    const cur = p[k] as P3;
    const next = p[(k + 1) % 4] as P3;
    const e1 = sub3(cur, prev);
    const e2 = sub3(next, cur);
    const l = Math.sqrt(dot3(e1, e1) * dot3(e2, e2));
    worst = Math.min(worst, l === 0 ? -1 : dot3(cross3(e1, e2), normal) / l);
  }
  return worst;
}

/**
 * Maximum-cardinality matching by the dummy reduction: every triangle gets a private dummy partner at
 * `SINGLE_COST`, and dummies pair among themselves at zero cost. A perfect matching of that graph
 * exists for every even triangle count, and its minimum cost pairs as many real triangles as possible.
 * `mate[i]` is the triangle partner of i, or -1 when i is single.
 */
function maximumMatching(
  n: number,
  edges: readonly MatchEdge[],
): { readonly ok: true; readonly mate: readonly number[] } | { readonly ok: false } {
  const all: MatchEdge[] = edges.slice();
  for (let i = 0; i < n; i++) all.push({ a: i, b: n + i, cost: SINGLE_COST });
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) all.push({ a: n + i, b: n + j, cost: 0 });
  const matched = minCostPerfectMatching(2 * n, all);
  if (!matched.ok) return { ok: false };
  const mate: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = matched.mate[i] as number;
    mate.push(u < n ? u : -1);
  }
  return { ok: true, mate };
}

/**
 * Best split of a folded quad through one interior point g on a diagonal: the candidate whose two
 * sub-quads have the largest smallest corner sine. Falls back to the best available when no
 * candidate makes both sub-quads convex, so the caller can still report the residual fold.
 */
function splitFold(
  cp: readonly [P3, P3, P3, P3],
  normal: P3,
): { readonly d: 0 | 1; readonly g: P3; readonly convex: boolean } {
  const centre = mid(mid(cp[0], cp[2]), mid(cp[1], cp[3]));
  let best: { d: 0 | 1; g: P3; score: number } | undefined;
  for (const d of [0, 1] as const) {
    const A = cp[d] as P3;
    const B = cp[(d + 1) % 4] as P3;
    const C = cp[(d + 2) % 4] as P3;
    const D = cp[(d + 3) % 4] as P3;
    const candidates = [
      centre,
      mid(A, C),
      mid(B, D),
      mid(A, centre),
      mid(C, centre),
      mid(B, centre),
      mid(D, centre),
    ];
    for (const g of candidates) {
      const score = Math.min(turnScore([A, B, C, g], normal), turnScore([C, D, A, g], normal));
      if (best === undefined || score > best.score) best = { d, g, score };
    }
  }
  const chosen = best ?? { d: 0 as const, g: centre, score: -1 };
  return { d: chosen.d, g: chosen.g, convex: chosen.score > 0 };
}

/**
 * Pair the triangles of one trimmed face into quads. `rings` carry uv and the shared mesh id of each
 * boundary sample; `position` resolves those ids and `addVertex` mints interior vertices.
 */
/**
 * Blossom-Quad fallback on the even-index ring. Each trim ring keeps every other shared sample as its
 * CDT boundary; the skipped sample of each CDT segment is a shared id, so a neighbour that uses the same
 * edge sees the same boundary ids. Every CDT triangle becomes three quads around its centroid. Each quad
 * must be convex about the triangle normal, else the face fails closed. Runs only when the matching has
 * no perfect solution; the caller decides that.
 */
function splitThreeEven(
  surface: Surface,
  rings: readonly TrimRing[],
  position: (id: number) => P3,
  addVertex: (p: P3) => number,
  options: TrimmedQuadOptions,
):
  | { readonly ok: true; readonly value: TrimmedQuads }
  | { readonly ok: false; readonly error: TrimmedQuadFailure } {
  for (const ring of rings) {
    if (ring.ids.length % 2 !== 0) return { ok: false, error: { reason: 'split-3-parity' } };
  }
  // Skipped (odd) shared sample of each CDT segment, keyed by the segment's shared id pair.
  const skipped = new Map<string, number>();
  const halved: TrimRing[] = rings.map((ring) => {
    const n = ring.ids.length;
    for (let k = 0; k < n; k += 2) {
      const a = ring.ids[k] as number;
      const m = ring.ids[(k + 1) % n] as number;
      const b = ring.ids[(k + 2) % n] as number;
      skipped.set(`${Math.min(a, b)},${Math.max(a, b)}`, m);
    }
    return {
      uv: ring.uv.filter((_, k) => k % 2 === 0),
      ids: ring.ids.filter((_, k) => k % 2 === 0),
    };
  });
  const trimmed = triangulateTrimmed(surface, halved, {
    angle: options.angle,
    maxPoints: options.maxPoints,
  });
  if (!trimmed.ok) {
    return { ok: false, error: { reason: 'trim-triangulation', detail: trimmed.error.reason } };
  }
  const { interior, triangles } = trimmed.value;
  const ids: number[] = [];
  for (const r of halved) for (const id of r.ids) ids.push(id);
  const boundaryCount = ids.length;
  const meshId: number[] = ids.slice();
  for (let i = 0; i < interior.length; i++) meshId.push(-1);
  const pos: P3[] = meshId.map((id, k) =>
    id >= 0
      ? position(id)
      : surfacePoint(
          surface,
          (interior[k - boundaryCount] as P2)[0],
          (interior[k - boundaryCount] as P2)[1],
        ),
  );
  const idOf = new Map<number, number>();
  const idFor = (k: number): number => {
    const known = idOf.get(k);
    if (known !== undefined) return known;
    const shared = meshId[k] as number;
    const id = shared >= 0 ? shared : addVertex(pos[k] as P3);
    idOf.set(k, id);
    return id;
  };
  // Midpoint of CDT edge (x, y): the skipped shared sample when the edge is a ring segment, otherwise a
  // new interior vertex minted once per edge (both triangles sharing it reuse the same id).
  const owned: number[] = [];
  const midOf = new Map<string, { id: number; p: P3 }>();
  const midFor = (x: number, y: number): { id: number; p: P3 } => {
    const ix = Math.min(x, y);
    const iy = Math.max(x, y);
    const key = `${ix},${iy}`;
    const known = midOf.get(key);
    if (known !== undefined) return known;
    const sx = meshId[x] as number;
    const sy = meshId[y] as number;
    let value: { id: number; p: P3 };
    const shared =
      sx >= 0 && sy >= 0 ? skipped.get(`${Math.min(sx, sy)},${Math.max(sx, sy)}`) : undefined;
    if (shared !== undefined) {
      value = { id: shared, p: position(shared) };
    } else {
      const p = mid(pos[x] as P3, pos[y] as P3);
      value = { id: addVertex(p), p };
      owned.push(value.id);
    }
    midOf.set(key, value);
    return value;
  };
  const quads: [number, number, number, number][] = [];
  for (const t of triangles) {
    const [a, b, c] = t;
    const normal = normalOf(pos, t);
    const cen: P3 = scale3(
      [
        (pos[a] as P3)[0] + (pos[b] as P3)[0] + (pos[c] as P3)[0],
        (pos[a] as P3)[1] + (pos[b] as P3)[1] + (pos[c] as P3)[1],
        (pos[a] as P3)[2] + (pos[b] as P3)[2] + (pos[c] as P3)[2],
      ],
      1 / 3,
    );
    const interiorPoint = splitCentre([pos[a] as P3, pos[b] as P3, pos[c] as P3], cen, (gg) =>
      [
        [a, b, c],
        [b, c, a],
        [c, a, b],
      ].every(([p, , r]) => {
        const pq = midFor(p as number, (p === a ? b : p === b ? c : a) as number);
        const rp = midFor(r as number, p as number);
        return convexAbout([pos[p as number] as P3, pq.p, gg, rp.p], normal);
      }),
    );
    if (!interiorPoint) return { ok: false, error: { reason: 'split-3-fold' } };
    const g = addVertex(interiorPoint);
    owned.push(g);
    for (const [p, q, r] of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ] as const) {
      const mpq = midFor(p, q);
      const mrp = midFor(r, p);
      quads.push([idFor(p), mpq.id, g, mrp.id]);
    }
  }
  return {
    ok: true,
    value: {
      quads,
      triangles: 0,
      pairs: 0,
      folded: 0,
      unresolved: 0,
      singles: [],
      owned,
      rowSkipped: 0,
      fallback: false,
      rowQuadCount: 0,
      split3: true,
    },
  };
}

export function quadrangulateTrimmed(
  surface: Surface,
  rings: readonly TrimRing[],
  position: (id: number) => P3,
  addVertex: (p: P3) => number,
  options: TrimmedQuadOptions,
):
  | { readonly ok: true; readonly value: TrimmedQuads }
  | { readonly ok: false; readonly error: TrimmedQuadFailure } {
  let boundary = 0;
  const ids: number[] = [];
  for (const ring of rings) {
    boundary += ring.uv.length;
    for (const id of ring.ids) ids.push(id);
  }
  if (boundary % 2 !== 0)
    return { ok: false, error: { reason: 'odd-ring-count', count: boundary } };

  if (options.rowFront) {
    const row = rowFrontInner(rings);
    if (!row.ok) return { ok: false, error: { reason: 'row-front-collision' } };
    const rowQuads: [number, number, number, number][] = [];
    const innerRings: TrimRing[] = [];
    rings.forEach((ring, r) => {
      if (row.skipped[r]) {
        innerRings.push({ uv: ring.uv, ids: ring.ids });
        return;
      }
      const inner = row.inner[r] as readonly P2[];
      const n = ring.uv.length;
      const innerIds = inner.map((p) => addVertex(surfacePoint(surface, p[0], p[1])));
      innerRings.push({ uv: inner, ids: innerIds });
      for (let k = 0; k < n; k++) {
        const a = ring.uv[k] as P2;
        const b = ring.uv[(k + 1) % n] as P2;
        const c = inner[(k + 1) % n] as P2;
        const outer = [ring.ids[k], ring.ids[(k + 1) % n], innerIds[(k + 1) % n], innerIds[k]] as [
          number,
          number,
          number,
          number,
        ];
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        rowQuads.push(area >= 0 ? outer : [outer[3], outer[2], outer[1], outer[0]]);
      }
    });
    const rowSkipped = row.skipped.filter(Boolean).length;
    // The row interior admits only pairs above the scaled-Jacobian floor; triangles that cannot pair
    // stay single (quad-dominant matching), so no sliver quad is forced by a perfect matching.
    const interior = quadrangulateTrimmed(surface, innerRings, position, addVertex, {
      ...options,
      rowFront: false,
      penalty: false,
      dominant: false,
      globalMatch: true,
    });
    if (!interior.ok) return interior;
    return {
      ok: true,
      value: {
        ...interior.value,
        quads: [...rowQuads, ...interior.value.quads],
        rowSkipped,
        // Leftover triangles stay in `triangles`; the row interior is quad-dominant by construction, not a strict-matching fallback.
        fallback: false,
        rowQuadCount: rowQuads.length,
        split3: interior.value.split3,
      },
    };
  }

  const trimmed = triangulateTrimmed(surface, rings, {
    angle: options.angle,
    maxPoints: options.maxPoints,
    ...(options.spacing === undefined ? {} : { spacing: options.spacing }),
  });
  if (!trimmed.ok) {
    return { ok: false, error: { reason: 'trim-triangulation', detail: trimmed.error.reason } };
  }
  const { interior, triangles } = trimmed.value;
  if (triangles.length > options.maxTriangles) {
    return { ok: false, error: { reason: 'matching-too-large', triangles: triangles.length } };
  }

  // Map combined indices (boundary samples first, then interior points) to mesh ids.
  const meshId: number[] = ids.slice();
  for (let i = 0; i < interior.length; i++) meshId.push(-1);
  const positionOf = (k: number): P3 => {
    const id = meshId[k] as number;
    if (id >= 0) return position(id);
    return surfacePoint(
      surface,
      (interior[k - boundary] as P2)[0],
      (interior[k - boundary] as P2)[1],
    );
  };
  const pos: P3[] = [];
  for (let k = 0; k < meshId.length; k++) pos.push(positionOf(k));

  // Dual edges: each interior triangle edge (shared by two triangles) joins them once.
  const directed = new Map<number, number>();
  const key = (a: number, b: number): number => a * meshId.length + b;
  triangles.forEach((t, i) => {
    for (let k = 0; k < 3; k++) directed.set(key(t[k] as number, t[(k + 1) % 3] as number), i);
  });
  const edges: MatchEdge[] = [];
  const pairEdge = new Map<
    number,
    { t: number; u: number; p: number; q: number; r: number; s: number }
  >();
  triangles.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const p = t[k] as number;
      const q = t[(k + 1) % 3] as number;
      const other = directed.get(key(q, p));
      if (other === undefined || other <= i) continue;
      const ot = triangles[other] as readonly [number, number, number];
      const r = t[(k + 2) % 3] as number;
      const s = ot.find((v) => v !== p && v !== q) as number;
      // Quad q, r, p, s is counter-clockwise in (u, v) because t = (p, q, r) and ot = (q, p, s).
      const quad = [q, r, p, s].map((v) => pos[v] as P3) as P3[];
      const normal = normalOf(pos, t);
      const convex = convexAbout(quad, normal);
      // quad-dominant admits every convex, flat pair (no SJ floor); the floor is opt-in via sjFloor / dominantSjFloor only.
      const admissible = options.dominant
        ? convex &&
          flatSafe(quad, normal) &&
          (!options.dominantSjFloor || pairSj(quad, normal) >= SJ_FLOOR)
        : options.globalMatch
          ? convex && flatSafe(quad, normal)
          : convex && (!options.sjFloor || pairSj(quad, normal) >= SJ_FLOOR);
      // A reflex corner folds the quad; strict mode gives it no edge, penalty mode a high cost.
      if (!admissible && !options.penalty) continue;
      const sjShortfall = options.globalMatch ? Math.max(0, SJ_FLOOR - pairSj(quad, normal)) : 0;
      edges.push({
        a: i,
        b: other,
        cost:
          quadCost(quad) +
          sjShortfall * SJ_SOFT_WEIGHT +
          (convex ? 0 : FOLD_PENALTY) +
          (options.pairCost === undefined ? 0 : options.pairCost(quad)),
      });
      pairEdge.set(key(i, other), { t: i, u: other, p, q, r, s });
    }
  });

  const matched =
    options.dominant && !options.globalMatch
      ? maximumMatching(triangles.length, edges)
      : minCostPerfectMatching(triangles.length, edges);
  if (!matched.ok) {
    if ('reason' in matched && matched.reason === 'no-perfect-matching') {
      if (options.fallback === 'split-3') {
        return splitThreeEven(surface, rings, position, addVertex, options);
      }
      return { ok: false, error: { reason: 'no-perfect-matching' } };
    }
    return { ok: false, error: { reason: 'bad-matching' } };
  }

  // Vertices shared by two triangles are minted once by index, so a quad may reuse interior ids.
  const idOf = new Map<number, number>();
  const idFor = (k: number): number => {
    const known = idOf.get(k);
    if (known !== undefined) return known;
    const shared = meshId[k] as number;
    const id = shared >= 0 ? shared : addVertex(pos[k] as P3);
    idOf.set(k, id);
    return id;
  };

  const quads: [number, number, number, number][] = [];
  const singles: [number, number, number][] = [];
  let pairs = 0;
  let folded = 0;
  let unresolved = 0;
  for (let i = 0; i < triangles.length; i++) {
    const u = matched.mate[i] as number;
    if (u < 0) {
      const t = triangles[i] as readonly [number, number, number];
      singles.push([idFor(t[0]), idFor(t[1]), idFor(t[2])]);
      continue;
    }
    if (u < i) continue;
    const pair = pairEdge.get(key(i, u)) ?? pairEdge.get(key(u, i));
    if (pair === undefined) return { ok: false, error: { reason: 'bad-matching' } };
    pairs++;
    const corners = [pair.q, pair.r, pair.p, pair.s];
    const cp = corners.map((v) => pos[v] as P3) as [P3, P3, P3, P3];
    const normal = normalOf(pos, triangles[i] as readonly [number, number, number]);
    if (convexAbout(cp, normal)) {
      quads.push(corners.map(idFor) as [number, number, number, number]);
      continue;
    }
    folded++;
    if (!splitFold(cp, normal).convex) unresolved++;
    const split = splitFold(cp, normal);
    const ids = corners.map(idFor);
    const g = addVertex(split.g);
    for (const quad of [
      [ids[split.d], ids[(split.d + 1) % 4], ids[(split.d + 2) % 4], g],
      [ids[(split.d + 2) % 4], ids[(split.d + 3) % 4], ids[split.d], g],
    ] as [number, number, number, number][]) {
      quads.push(quad);
    }
  }
  return {
    ok: true,
    value: {
      quads,
      triangles: triangles.length,
      pairs,
      folded,
      unresolved,
      singles,
      owned: [],
      rowSkipped: 0,
      fallback: false,
      rowQuadCount: 0,
      split3: false,
    },
  };
}

/**
 * Interior point of a split triangle: the centroid when it keeps all three quads convex, else the
 * feasible barycentric grid point nearest the centroid. The point is private to its triangle, so no
 * neighbour depends on it. Undefined when no grid point is feasible.
 */
function splitCentre(
  corners: readonly [P3, P3, P3],
  cen: P3,
  feasible: (g: P3) => boolean,
): P3 | undefined {
  if (feasible(cen)) return cen;
  const [A, B, C] = corners;
  const N = 24;
  let best: { g: P3; dist: number } | undefined;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N - i; j++) {
      const u = i / N;
      const v = j / N;
      const w = 1 - u - v;
      const g: P3 = [0, 1, 2].map(
        (k) => w * (A[k] as number) + u * (B[k] as number) + v * (C[k] as number),
      ) as unknown as P3;
      const dist = len3(sub3(g, cen));
      if (best !== undefined && dist >= best.dist) continue;
      if (feasible(g)) best = { g, dist };
    }
  }
  return best?.g;
}
