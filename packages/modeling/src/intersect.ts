import { maxOf, minOf } from './arrays';
import { hypot2 } from './dmath';
import { add, faceCentroid, scale, type Tuple3, triangulateLoop, windingNumber } from './geom';
import { type EditMesh, NONE } from './mesh';
import type { OpDiagnostic } from './ops';
import { orient2d, orient3d } from './predicates';

/** `cross`: the triangles properly pierce each other; `touch`: they only meet in contact. */
export type Contact = 'none' | 'touch' | 'cross';

type P = readonly [number, number, number];

function strongest(a: Contact, b: Contact): Contact {
  return a === 'cross' || b === 'cross'
    ? 'cross'
    : a === 'touch' || b === 'touch'
      ? 'touch'
      : 'none';
}

/** Drop the axis where the triangle's normal is largest; projection is exact. */
function dropAxis(t: readonly P[]): [number, number] {
  const [a, b, c] = t as [P, P, P];
  const u: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Tuple3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Tuple3 = [
    Math.abs(u[1] * v[2] - u[2] * v[1]),
    Math.abs(u[2] * v[0] - u[0] * v[2]),
    Math.abs(u[0] * v[1] - u[1] * v[0]),
  ];
  const drop = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2;
  return [(drop + 1) % 3, (drop + 2) % 3];
}

function segmentsContact2d(a: number[], b: number[], c: number[], d: number[]): Contact {
  const o = (p: number[], q: number[], r: number[]) =>
    Math.sign(
      orient2d(
        p[0] as number,
        p[1] as number,
        q[0] as number,
        q[1] as number,
        r[0] as number,
        r[1] as number,
      ),
    );
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 'cross';
  const within = (p: number[], q: number[], r: number[]) =>
    Math.min(p[0] as number, q[0] as number) <= (r[0] as number) &&
    (r[0] as number) <= Math.max(p[0] as number, q[0] as number) &&
    Math.min(p[1] as number, q[1] as number) <= (r[1] as number) &&
    (r[1] as number) <= Math.max(p[1] as number, q[1] as number);
  if (
    (d1 === 0 && within(a, b, c)) ||
    (d2 === 0 && within(a, b, d)) ||
    (d3 === 0 && within(c, d, a)) ||
    (d4 === 0 && within(c, d, b))
  ) {
    return 'touch';
  }
  return 'none';
}

/** Point inside (strictly), on the boundary of, or outside a 2D triangle. */
function pointInTriangle2d(p: number[], t: number[][]): Contact {
  const signs = [0, 1, 2].map((i) => {
    const a = t[i] as number[];
    const b = t[(i + 1) % 3] as number[];
    return Math.sign(
      orient2d(
        a[0] as number,
        a[1] as number,
        b[0] as number,
        b[1] as number,
        p[0] as number,
        p[1] as number,
      ),
    );
  });
  const orientation = Math.sign(
    orient2d(
      (t[0] as number[])[0] as number,
      (t[0] as number[])[1] as number,
      (t[1] as number[])[0] as number,
      (t[1] as number[])[1] as number,
      (t[2] as number[])[0] as number,
      (t[2] as number[])[1] as number,
    ),
  );
  if (signs.every((s) => s === orientation)) return 'cross';
  if (signs.every((s) => s === orientation || s === 0)) return 'touch';
  return 'none';
}

/** Same-plane orientation of two coplanar triangles: +1 same facing, -1 opposite. */
function facing(t1: readonly P[], t2: readonly P[]): number {
  const n = (t: readonly P[]) => {
    const [a, b, c] = t as [P, P, P];
    const u: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Tuple3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  };
  const a = n(t1);
  const b = n(t2);
  return Math.sign(
    (a[0] as number) * (b[0] as number) +
      (a[1] as number) * (b[1] as number) +
      (a[2] as number) * (b[2] as number),
  );
}

/**
 * Coplanar triangles: `cross` when their interiors overlap with the same facing
 * (coincident or overlapping surfaces), `touch` when they overlap facing each other
 * (flush contact, a fold) or, with `boundary`, meet only on their boundaries; else
 * `none`. Triangles sharing a corner or an edge pass `boundary: false`, since they
 * always meet there.
 */
function coplanarContact(
  t1: readonly P[],
  t2: readonly P[],
  boundary = true,
  tolerance = 0,
): Contact {
  const [i, j] = dropAxis(t1);
  const a = t1.map((p) => [p[i], p[j]] as number[]);
  const b = t2.map((p) => [p[i], p[j]] as number[]);
  const centroid = (t: number[][]) =>
    [0, 1].map((k) => t.reduce((sum, p) => sum + (p[k] as number), 0) / 3);
  let edge: Contact = 'none';
  let overlap =
    pointInTriangle2d(centroid(a), b) === 'cross' || pointInTriangle2d(centroid(b), a) === 'cross';
  for (let k = 0; k < 3 && !overlap; k++) {
    for (let l = 0; l < 3; l++) {
      const edges = segmentsContact2d(
        a[k] as number[],
        a[(k + 1) % 3] as number[],
        b[l] as number[],
        b[(l + 1) % 3] as number[],
      );
      if (edges === 'cross') overlap = true;
      edge = strongest(edge, edges);
    }
    const inA = pointInTriangle2d(b[k] as number[], a);
    const inB = pointInTriangle2d(a[k] as number[], b);
    if (inA === 'cross' || inB === 'cross') overlap = true;
    edge = strongest(edge, strongest(inA, inB));
  }
  if (overlap) {
    if (facing(t1, t2) <= 0) return 'touch';
    // Separate parts cut from one another (splitBy pieces, a lifted cover) meet with
    // vertices an ulp apart: a same-facing overlap no wider than the tolerance is contact.
    return tolerance > 0 && overlapWidth(t1, a, b) <= tolerance ? 'touch' : 'cross';
  }
  return boundary && edge !== 'none' ? 'touch' : 'none';
}

/**
 * Effective width (twice the area over the perimeter) of the overlap of two coplanar
 * triangles, measured in the plane: their 2D projections `a` and `b` are clipped
 * against each other, and the projection's foreshortening is undone.
 */
function overlapWidth(t: readonly P[], a: readonly number[][], b: readonly number[][]): number {
  const signedArea = (poly: readonly number[][]) =>
    poly.reduce((sum, p, k) => {
      const q = poly[(k + 1) % poly.length] as number[];
      return sum + (p[0] as number) * (q[1] as number) - (q[0] as number) * (p[1] as number);
    }, 0) / 2;
  const ccw = (poly: readonly number[][]) =>
    signedArea(poly) < 0 ? [...poly].reverse() : [...poly];
  let clipped = ccw(a);
  const clip = ccw(b);
  for (let k = 0; k < 3 && clipped.length > 0; k++) {
    const e0 = clip[k] as number[];
    const e1 = clip[(k + 1) % 3] as number[];
    const inside = (p: number[]) =>
      ((e1[0] as number) - (e0[0] as number)) * ((p[1] as number) - (e0[1] as number)) -
        ((e1[1] as number) - (e0[1] as number)) * ((p[0] as number) - (e0[0] as number)) >=
      0;
    const next: number[][] = [];
    for (let m = 0; m < clipped.length; m++) {
      const p = clipped[m] as number[];
      const q = clipped[(m + 1) % clipped.length] as number[];
      const pi = inside(p);
      const qi = inside(q);
      if (pi) next.push(p);
      if (pi !== qi) {
        const dx = (e1[0] as number) - (e0[0] as number);
        const dy = (e1[1] as number) - (e0[1] as number);
        const num =
          dx * ((p[1] as number) - (e0[1] as number)) - dy * ((p[0] as number) - (e0[0] as number));
        const den =
          dx * ((p[1] as number) - (q[1] as number)) - dy * ((p[0] as number) - (q[0] as number));
        const s = den === 0 ? 0 : num / den;
        next.push([
          (p[0] as number) + ((q[0] as number) - (p[0] as number)) * s,
          (p[1] as number) + ((q[1] as number) - (p[1] as number)) * s,
        ]);
      }
    }
    clipped = next;
  }
  if (clipped.length < 3) return 0;
  const area = Math.abs(signedArea(clipped));
  const perimeter = clipped.reduce((sum, p, k) => {
    const q = clipped[(k + 1) % clipped.length] as number[];
    return sum + hypot2((q[0] as number) - (p[0] as number), (q[1] as number) - (p[1] as number));
  }, 0);
  if (perimeter === 0) return 0;
  const n = normalOf(t);
  const length = Math.sqrt(dot3(n, n));
  const kept = Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])) / length;
  return (2 * area) / perimeter / kept;
}

function segmentTriangle(p: P, q: P, t: readonly P[]): Contact {
  const [a, b, c] = t as [P, P, P];
  return segmentTriangleSides(
    p,
    q,
    t,
    Math.sign(orient3d(a, b, c, p)),
    Math.sign(orient3d(a, b, c, q)),
  );
}

/** `segmentTriangle` with the sides of p and q against the plane of `t` known. */
function segmentTriangleSides(p: P, q: P, t: readonly P[], sp: number, sq: number): Contact {
  const [a, b, c] = t as [P, P, P];
  if (sp * sq > 0) return 'none';
  if (sp === 0 && sq === 0) {
    const [i, j] = dropAxis(t);
    const s = [p, q].map((x) => [x[i], x[j]] as number[]);
    const tri = t.map((x) => [x[i], x[j]] as number[]);
    let out: Contact = 'none';
    for (let k = 0; k < 3; k++) {
      out = strongest(
        out,
        segmentsContact2d(
          s[0] as number[],
          s[1] as number[],
          tri[k] as number[],
          tri[(k + 1) % 3] as number[],
        ),
      );
    }
    const inside = strongest(
      pointInTriangle2d(s[0] as number[], tri),
      pointInTriangle2d(s[1] as number[], tri),
    );
    return out === 'none' && inside === 'none' ? 'none' : 'touch';
  }
  const e = [
    Math.sign(orient3d(p, q, a, b)),
    Math.sign(orient3d(p, q, b, c)),
    Math.sign(orient3d(p, q, c, a)),
  ];
  const pierces = e.every((s) => s > 0) || e.every((s) => s < 0);
  const grazes = !pierces && (e.every((s) => s >= 0) || e.every((s) => s <= 0));
  if (!pierces && !grazes) return 'none';
  return pierces && sp !== 0 && sq !== 0 ? 'cross' : 'touch';
}

/**
 * Every vertex of each triangle lies within `tolerance` of the other's plane: the two
 * are one surface to the model (walls of parts cut from each other end up an ulp
 * apart and an ulp out of plane), so they are classified as coplanar.
 */
function nearCoplanar(t1: readonly P[], t2: readonly P[], tolerance: number): boolean {
  const within = (t: readonly P[], plane: readonly P[]) => {
    const n = normalOf(plane);
    const length = Math.sqrt(dot3(n, n));
    if (length === 0) return false;
    const o = plane[0] as P;
    return t.every((p) => Math.abs(dot3(minus(p, o), n)) / length <= tolerance);
  };
  return within(t1, t2) && within(t2, t1);
}

function coplanar(t1: readonly P[], t2: readonly P[]): boolean {
  return t2.every((p) => orient3d(t1[0] as P, t1[1] as P, t1[2] as P, p) === 0);
}

/** Exact contact class of two triangles that share no vertex. */
export function triangleContact(t1: readonly P[], t2: readonly P[], tolerance = 0): Contact {
  if (tolerance > 0 && nearCoplanar(t1, t2, tolerance)) {
    return coplanarContact(t1, t2, true, tolerance);
  }
  const side = (t: readonly P[], others: readonly P[]) =>
    others.map((p) => Math.sign(orient3d(t[0] as P, t[1] as P, t[2] as P, p)));
  const s2 = side(t1, t2);
  if (s2.every((s) => s > 0) || s2.every((s) => s < 0)) return 'none';
  const s1 = side(t2, t1);
  if (s1.every((s) => s > 0) || s1.every((s) => s < 0)) return 'none';
  if (s2.every((s) => s === 0)) return coplanarContact(t1, t2, true, tolerance);
  let out: Contact = 'none';
  for (let k = 0; k < 3; k++) {
    const next = (k + 1) % 3;
    out = strongest(
      out,
      segmentTriangleSides(t1[k] as P, t1[next] as P, t2, s1[k] as number, s1[next] as number),
    );
    out = strongest(
      out,
      segmentTriangleSides(t2[k] as P, t2[next] as P, t1, s2[k] as number, s2[next] as number),
    );
  }
  return out;
}

/**
 * Contact beyond the shared corner of two triangles that share exactly one vertex,
 * each given with that vertex first. Off-plane, any contact beyond the corner must
 * leave one triangle through its opposite edge, so the two opposite edges are tested
 * against the other triangle; in one plane the interiors are compared.
 */
export function cornerContact(t1: readonly P[], t2: readonly P[], tolerance = 0): Contact {
  if (coplanar(t1, t2) || (tolerance > 0 && nearCoplanar(t1, t2, tolerance))) {
    return coplanarContact(t1, t2, false, tolerance);
  }
  return strongest(
    segmentTriangle(t1[1] as P, t1[2] as P, t2),
    segmentTriangle(t2[1] as P, t2[2] as P, t1),
  );
}

type Segment = readonly [P, P];

function minus(a: P, b: P): Tuple3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: readonly number[], b: readonly number[]): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

function normalOf(t: readonly P[]): Tuple3 {
  const u = minus(t[1] as P, t[0] as P);
  const v = minus(t[2] as P, t[0] as P);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

/** Points where triangle `t` meets the plane of `plane` (its section line's two ends). */
function section(t: readonly P[], plane: readonly P[]): P[] {
  const n = normalOf(plane);
  const o = plane[0] as P;
  const d = t.map((p) => dot3(minus(p, o), n));
  const out: P[] = [];
  for (let k = 0; k < 3; k++) {
    const a = t[k] as P;
    const b = t[(k + 1) % 3] as P;
    const da = d[k] as number;
    const db = d[(k + 1) % 3] as number;
    if (da === 0) out.push(a);
    if (da * db < 0) {
      const s = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]);
    }
  }
  return out;
}

/** The segment two non-coplanar crossing triangles share (approximate, for tolerance tests). */
function crossingSegment(t1: readonly P[], t2: readonly P[]): Segment | undefined {
  const line = (() => {
    const a = normalOf(t1);
    const b = normalOf(t2);
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  })();
  const span = dot3(line, line);
  const s1 = section(t1, t2);
  const s2 = section(t2, t1);
  if (span === 0 || s1.length === 0 || s2.length === 0) return undefined;
  const base = s1[0] as P;
  const at = (p: P) => dot3(minus(p, base), line);
  const r1 = s1.map(at);
  const r2 = s2.map(at);
  const lo = Math.max(minOf(r1), minOf(r2));
  const hi = Math.min(maxOf(r1), maxOf(r2));
  if (lo > hi) return undefined;
  const point = (r: number): P => [
    base[0] + ((line[0] as number) * r) / span,
    base[1] + ((line[1] as number) * r) / span,
    base[2] + ((line[2] as number) * r) / span,
  ];
  return [point(lo), point(hi)];
}

function distanceToSegment(p: P, a: P, b: P): number {
  const ab = minus(b, a);
  const span = dot3(ab, ab);
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, dot3(minus(p, a), ab) / span));
  const q = minus(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
  return Math.sqrt(dot3(q, q));
}

/**
 * Whether two crossing triangles only overlap within `tolerance`: their shared segment
 * lies within `tolerance` of one boundary edge of either face, which is how parts that
 * rest on, beside or over the edge of each other a fraction of the tolerance deep cross.
 */
function shallow(
  t1: readonly P[],
  t2: readonly P[],
  edges: readonly Segment[],
  tolerance: number,
): boolean {
  const segment = crossingSegment(t1, t2);
  // The exact predicates saw a crossing that floating point cannot even place: it is
  // narrower than any tolerance.
  if (segment === undefined) return true;
  return edges.some(
    ([a, b]) =>
      distanceToSegment(segment[0], a, b) <= tolerance &&
      distanceToSegment(segment[1], a, b) <= tolerance,
  );
}

/** Two triangles that share an edge only meet beyond it when folded flat onto each other. */
export function edgeContact(t1: readonly P[], t2: readonly P[], tolerance = 0): Contact {
  return coplanar(t1, t2) || (tolerance > 0 && nearCoplanar(t1, t2, tolerance))
    ? coplanarContact(t1, t2, false, tolerance)
    : 'none';
}

/** @internal Edge-connected components of the mesh faces and whether each is closed. */
export function components(mesh: EditMesh): {
  of: Map<number, number>;
  faces: number[][];
  closed: boolean[];
} {
  const of = new Map<number, number>();
  const faces: number[][] = [];
  const closed: boolean[] = [];
  for (const seed of mesh.faces()) {
    if (of.has(seed)) continue;
    const id = faces.length;
    const list: number[] = [];
    let isClosed = true;
    const stack = [seed];
    of.set(seed, id);
    while (stack.length > 0) {
      const f = stack.pop() as number;
      list.push(f);
      for (const h of mesh.faceHalves(f)) {
        const g = mesh.hFace[h ^ 1] as number;
        if (g === NONE) isClosed = false;
        else if (!of.has(g)) {
          of.set(g, id);
          stack.push(g);
        }
      }
    }
    faces.push(list);
    closed.push(isClosed);
  }
  return { of, faces, closed };
}

/** @internal Distance from `p` to the closed triangle `t`. */
export function pointTriangleDistance(p: P, t: readonly P[]): number {
  const [a, b, c] = t as [P, P, P];
  const n = normalOf(t);
  const span = Math.sqrt(dot3(n, n));
  if (span > 0) {
    const d = dot3(minus(p, a), n) / span;
    const q: P = [p[0] - (n[0] * d) / span, p[1] - (n[1] * d) / span, p[2] - (n[2] * d) / span];
    const inside = [0, 1, 2].every((k) => {
      const e0 = t[k] as P;
      const e1 = t[(k + 1) % 3] as P;
      return dot3(normalOf([e0, e1, q]), n) >= 0;
    });
    if (inside) return Math.abs(d);
  }
  return Math.min(
    distanceToSegment(p, a, b),
    distanceToSegment(p, b, c),
    distanceToSegment(p, c, a),
  );
}

/**
 * Whether closed part `inner` reaches deeper than `tolerance` into closed part
 * `outer`: one of its vertices or face centroids lies inside `outer` (winding number
 * above 1/2) and farther than `tolerance` from every triangle of it.
 */
function reachesInto(
  mesh: EditMesh,
  inner: readonly number[],
  outer: readonly number[],
  triangles: readonly (readonly P[])[],
  tolerance: number,
): boolean {
  const samples: P[] = [];
  const seen = new Set<number>();
  for (const f of inner) {
    samples.push(faceCentroid(mesh, f));
    for (const v of mesh.faceVertices(f)) {
      if (seen.has(v)) continue;
      seen.add(v);
      samples.push(mesh.position(v));
    }
  }
  return samples.some(
    (p) =>
      windingNumber(mesh, outer, p as Tuple3) > 0.5 &&
      triangles.every((t) => pointTriangleDistance(p, t) > tolerance),
  );
}

export interface FaceContact {
  readonly faces: readonly [number, number];
  readonly contact: 'touch' | 'cross';
}

/**
 * Exact contacts between triangles of different faces (sweep over x extents).
 * Triangles sharing no vertex use `triangleContact`, one shared vertex
 * `cornerContact` and one shared edge `edgeContact`; a crossing whose shared segment
 * lies within `tolerance` of a face boundary edge counts as contact, unless the two
 * closed parts it joins reach deeper than `tolerance` into each other, which makes
 * every contact between them a crossing. Faces with the same vertex set
 * (the two sides of a double-sided sheet) and triangles of one face are not tested.
 */
export function faceContacts(
  mesh: EditMesh,
  limit: number,
  tolerance: number,
  /** Only pairs with at least one of these faces (an operation's written faces). */
  only?: ReadonlySet<number>,
): { contacts: FaceContact[]; total: number } {
  const tris: { face: number; verts: number[]; points: P[]; lo: number[]; hi: number[] }[] = [];
  // Faces with the same vertex set share an id (the two sides of a double-sided sheet),
  // assigned when a pair first needs it.
  const setIds = new Map<string, number>();
  const vertexSet = new Int32Array(mesh.faceHighWater).fill(NONE);
  const setIdOf = (f: number): number => {
    let id = vertexSet[f] as number;
    if (id !== NONE) return id;
    const key = mesh
      .faceVertices(f)
      .sort((x, y) => x - y)
      .join(',');
    id = setIds.get(key) ?? setIds.size;
    setIds.set(key, id);
    vertexSet[f] = id;
    return id;
  };
  const boundary = (f: number): Segment[] => {
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    return points.map((p, i) => [p, points[(i + 1) % points.length] as P] as const);
  };
  // A face outside `only` pairs only with `only` faces, so one whose box misses their
  // union (grown by the tolerance, as the sweep grows it) never needs triangulating.
  const reachLo = [Infinity, Infinity, Infinity];
  const reachHi = [-Infinity, -Infinity, -Infinity];
  if (only !== undefined) {
    for (const f of only) {
      for (const v of mesh.faceVertices(f)) {
        const p = mesh.position(v);
        for (let a = 0; a < 3; a++) {
          reachLo[a] = Math.min(reachLo[a] as number, (p[a] as number) - tolerance);
          reachHi[a] = Math.max(reachHi[a] as number, (p[a] as number) + tolerance);
        }
      }
    }
  }
  for (const f of mesh.faces()) {
    const verts = mesh.faceVertices(f);
    const points = verts.map((v) => mesh.position(v));
    if (only !== undefined && !only.has(f)) {
      let near = true;
      for (let a = 0; a < 3 && near; a++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of points) {
          lo = Math.min(lo, p[a] as number);
          hi = Math.max(hi, p[a] as number);
        }
        near = lo <= (reachHi[a] as number) && hi >= (reachLo[a] as number);
      }
      if (!near) continue;
    }
    const indices = triangulateLoop(points);
    if (indices === undefined) continue;
    for (let i = 0; i < indices.length; i += 3) {
      const corners = [indices[i], indices[i + 1], indices[i + 2]] as [number, number, number];
      const tp = corners.map((k) => points[k] as P) as [P, P, P];
      const [p0, p1, p2] = tp;
      tris.push({
        face: f,
        verts: corners.map((k) => verts[k] as number),
        points: tp,
        lo: [0, 1, 2].map((a) => Math.min(p0[a] as number, p1[a] as number, p2[a] as number)),
        hi: [0, 1, 2].map((a) => Math.max(p0[a] as number, p1[a] as number, p2[a] as number)),
      });
    }
  }
  tris.sort((a, b) => (a.lo[0] as number) - (b.lo[0] as number));
  // Flat copies of the sweep keys, and skip links to the next triangle of an `only`
  // face: a triangle outside `only` pairs only with those, in the same sweep order.
  const count = tris.length;
  const lo = new Float64Array(count * 3);
  const hi = new Float64Array(count * 3);
  const faceOf = new Int32Array(count);
  const nextWanted = new Int32Array(count + 1).fill(count);
  for (let i = count - 1; i >= 0; i--) {
    const t = tris[i] as (typeof tris)[number];
    for (let k = 0; k < 3; k++) {
      lo[i * 3 + k] = t.lo[k] as number;
      hi[i * 3 + k] = t.hi[k] as number;
    }
    faceOf[i] = t.face;
    nextWanted[i] = only === undefined || only.has(t.face) ? i : (nextWanted[i + 1] as number);
  }
  const seen = new Map<string, FaceContact>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    const a = tris[i] as (typeof tris)[number];
    const wanted = nextWanted[i] === i;
    // Boxes grow by the tolerance: flat faces an ulp apart have disjoint exact boxes.
    const reach0 = (hi[i * 3] as number) + tolerance;
    const reach1 = (hi[i * 3 + 1] as number) + tolerance;
    const reach2 = (hi[i * 3 + 2] as number) + tolerance;
    const from1 = lo[i * 3 + 1] as number;
    const from2 = lo[i * 3 + 2] as number;
    for (
      let j = wanted ? i + 1 : (nextWanted[i + 1] as number);
      j < count;
      j = wanted ? j + 1 : (nextWanted[j + 1] as number)
    ) {
      if ((lo[j * 3] as number) > reach0) break;
      if (faceOf[j] === a.face) continue;
      if (
        (lo[j * 3 + 1] as number) > reach1 ||
        from1 > (hi[j * 3 + 1] as number) + tolerance ||
        (lo[j * 3 + 2] as number) > reach2 ||
        from2 > (hi[j * 3 + 2] as number) + tolerance
      ) {
        continue;
      }
      const b = tris[j] as (typeof tris)[number];
      const bv = b.verts;
      const b0 = bv[0] as number;
      const b1 = bv[1] as number;
      const b2 = bv[2] as number;
      let shared = 0;
      let firstShared = NONE;
      for (let k = 0; k < 3; k++) {
        const v = a.verts[k] as number;
        if (v !== b0 && v !== b1 && v !== b2) continue;
        if (shared++ === 0) firstShared = v;
      }
      if (shared === 3 || setIdOf(a.face) === setIdOf(b.face)) continue;
      let contact: Contact;
      if (shared === 0) contact = triangleContact(a.points, b.points, tolerance);
      else if (shared === 2) contact = edgeContact(a.points, b.points, tolerance);
      else {
        const first = (t: typeof a) => {
          const k = t.verts.indexOf(firstShared);
          return [0, 1, 2].map((m) => t.points[(k + m) % 3] as P);
        };
        contact = cornerContact(first(a), first(b), tolerance);
      }
      if (contact === 'none') continue;
      // A crossing within the model tolerance of a face edge is contact (positions computed
      // in floating point land within an ulp of each other); coplanar duplicates stay crossings.
      if (
        contact === 'cross' &&
        !coplanar(a.points, b.points) &&
        !nearCoplanar(a.points, b.points, tolerance) &&
        shallow(a.points, b.points, [...boundary(a.face), ...boundary(b.face)], tolerance)
      ) {
        contact = 'touch';
      }
      const key = a.face < b.face ? `${a.face},${b.face}` : `${b.face},${a.face}`;
      const known = seen.get(key);
      if (known === undefined) total++;
      if (known === undefined || (known.contact === 'touch' && contact === 'cross')) {
        seen.set(key, {
          faces: a.face < b.face ? [a.face, b.face] : [b.face, a.face],
          contact,
        });
      }
    }
  }
  // Two closed parts in contact overlap for real when one reaches deeper than the
  // tolerance into the other, however shallow each face pair looks: a part sunk half
  // its height through an ulp-smaller opening, or cubes crossing on face diagonals.
  if ([...seen.values()].every((c) => c.contact === 'cross'))
    return finalContacts(seen, limit, total);
  const parts = components(mesh);
  const triangles = new Map<number, P[][]>();
  for (const t of tris) {
    const c = parts.of.get(t.face) as number;
    const list = triangles.get(c) ?? [];
    list.push(t.points);
    triangles.set(c, list);
  }
  const verdict = new Map<string, boolean>();
  for (const [key, contact] of seen) {
    if (contact.contact === 'cross') continue;
    const ca = parts.of.get(contact.faces[0]) as number;
    const cb = parts.of.get(contact.faces[1]) as number;
    if (ca === cb || !parts.closed[ca] || !parts.closed[cb]) continue;
    const pair = ca < cb ? `${ca},${cb}` : `${cb},${ca}`;
    let deep = verdict.get(pair);
    if (deep === undefined) {
      const faces = (c: number) => parts.faces[c] as number[];
      const solid = (c: number) => triangles.get(c) ?? [];
      deep =
        reachesInto(mesh, faces(ca), faces(cb), solid(cb), tolerance) ||
        reachesInto(mesh, faces(cb), faces(ca), solid(ca), tolerance);
      verdict.set(pair, deep);
    }
    if (deep) seen.set(key, { ...contact, contact: 'cross' });
  }
  return finalContacts(seen, limit, total);
}

function finalContacts(
  seen: ReadonlyMap<string, FaceContact>,
  limit: number,
  total: number,
): { contacts: FaceContact[]; total: number } {
  const contacts = [...seen.values()]
    .sort((x, y) => (x.contact === y.contact ? 0 : x.contact === 'cross' ? -1 : 1))
    .slice(0, limit);
  return { contacts, total };
}

/** @internal Order-free key of a face pair. */
export const pairKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);

/**
 * @internal Face pairs (`pairKey`) of `faces` already in contact before an operation:
 * overlapping parts of an assembly may cross at any size, so only other crossings are the
 * operation's own.
 */
export function contactPairs(
  mesh: EditMesh,
  faces: ReadonlySet<number>,
  tolerance: number,
): ReadonlySet<string> {
  return new Set(
    faceContacts(mesh, Number.MAX_SAFE_INTEGER, tolerance, faces).contacts.map((c) =>
      pairKey(...c.faces),
    ),
  );
}

/** Pairs listed, and midpoints located, by a crossing diagnostic. */
const CROSSING_PAIRS = 64;
const CROSSING_POINTS = 16;

/**
 * Crossings that involve a face the operation wrote are self-intersections it created:
 * a confirmed `warn` diagnostic with the pairs and their midpoints, or undefined.
 */
export function crossingDiagnostic(
  mesh: EditMesh,
  written: ReadonlySet<number>,
  tolerance: number,
  op: string,
  /** The crossing contacts of `written`, when the caller already has them. */
  known?: readonly FaceContact[],
): OpDiagnostic | undefined {
  const crossing = (
    known ?? faceContacts(mesh, Number.MAX_SAFE_INTEGER, tolerance, written).contacts
  ).filter((c) => c.contact === 'cross');
  if (crossing.length === 0) return undefined;
  const pairs = crossing.slice(0, CROSSING_PAIRS).map((c) => c.faces);
  return {
    severity: 'warn',
    message: `the ${op} self-intersects: ${crossing.length} face pair(s) cross (partial result); inspect detail.points`,
    detail: {
      certainty: 'confirmed',
      total: crossing.length,
      pairs,
      points: pairs
        .slice(0, CROSSING_POINTS)
        .map(([a, b]) => scale(add(faceCentroid(mesh, a), faceCentroid(mesh, b)), 0.5)),
    },
  };
}
