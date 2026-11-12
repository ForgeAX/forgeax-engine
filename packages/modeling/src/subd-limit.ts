import { err, ok, type Result } from '@forgeax/engine-types';
import type { SubdivisionBoundary } from './compute/job';
import { creaseWeights, edgeSharpness } from './crease';
import { cos, hypot3, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import { type EditMesh, NONE } from './mesh';

/**
 * Limit class of a vertex under the Catmull-Clark rules `subdivide` applies, after every
 * half-sharp crease has decayed: `smooth` has no infinite crease edge, `crease` two (a cubic
 * B-spline curve along them), `corner` three or more or a pinned boundary corner (stays
 * put). A vertex with exactly one infinite crease edge (a dart) has no closed-form limit and
 * is reported as `model-precondition`; a dart of finite sharpness decays to `smooth`.
 */
export type LimitKind = 'smooth' | 'crease' | 'corner';

export interface LimitOptions {
  /** Vertex ids to evaluate (ascending order of the result); default every used vertex. */
  readonly vertices?: readonly number[];
  /** Open-boundary rule, as for `subdivide` (default `edgeAndCorner`). */
  readonly boundary?: SubdivisionBoundary;
  /** Work units for this query (one per face corner, times 24); default unbounded. */
  readonly budget?: number;
  /** Sharpness of flagged edges that store no level (as for `subdivide`; default infinite). */
  readonly creaseSharpness?: number;
}

/**
 * Limit positions and normals of a Catmull-Clark cage, parallel arrays in ascending vertex id
 * order. `normal` is the unit surface normal (right-hand rule on the face winding) of
 * `smooth` vertices; a `crease` or `corner` vertex has two or more tangent
 * planes, so its three components are zero.
 */
export interface LimitSurface {
  readonly vertices: Int32Array;
  readonly position: Float64Array;
  readonly normal: Float64Array;
  readonly kind: readonly LimitKind[];
  /** Edges at the vertex (faces + 1 on an open fan). */
  readonly valence: Int32Array;
}

const UNITS_PER_CORNER = 24;

/** Correctly rounded sum of the terms, independent of their order (Shewchuk partials). */
export function exactSum(terms: readonly number[]): number {
  const partials: number[] = [];
  for (const term of terms) {
    let x = term;
    let used = 0;
    for (const p of partials) {
      let y = p;
      if (Math.abs(x) < Math.abs(y)) {
        const t = x;
        x = y;
        y = t;
      }
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo !== 0) partials[used++] = lo;
      x = hi;
    }
    partials.length = used;
    partials.push(x);
  }
  let n = partials.length;
  if (n === 0) return 0;
  n--;
  let hi = partials[n] as number;
  let lo = 0;
  while (n > 0) {
    const x = hi;
    n--;
    const y = partials[n] as number;
    hi = x + y;
    lo = y - (hi - x);
    if (lo !== 0) break;
  }
  const below = n > 0 ? (partials[n - 1] as number) : 0;
  if (n > 0 && ((lo < 0 && below < 0) || (lo > 0 && below > 0))) {
    const y = lo * 2;
    const x = hi + y;
    if (y === x - hi) hi = x;
  }
  return hi + 0;
}

/** Sum of the weighted points per coordinate, divided by `divisor`. */
function combine(terms: readonly (readonly [number, Tuple3])[], divisor: number): Tuple3 {
  const out: Tuple3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] = exactSum(terms.map(([w, p]) => w * (p[k] as number))) / divisor;
  }
  return out;
}

function facePoint(mesh: EditMesh, f: number): Tuple3 {
  const points = mesh.faceVertices(f).map((v) => mesh.position(v));
  return combine(
    points.map((p) => [1, p] as const),
    points.length,
  );
}

interface Fan {
  /** Ring edge ids in counter-clockwise order around the vertex. */
  readonly edges: number[];
  /** Face between ring edge i and i + 1 (the last wraps on a closed fan). */
  readonly faces: number[];
  readonly closed: boolean;
}

function walkFan(mesh: EditMesh, start: number): Fan | undefined {
  let first = start;
  for (;;) {
    const back = first ^ 1;
    if ((mesh.hFace[back] as number) === NONE) break;
    first = mesh.hNext[back] as number;
    if (first === start) break;
  }
  const edges: number[] = [];
  const faces: number[] = [];
  let h = first;
  let closed = false;
  for (;;) {
    edges.push(h >> 1);
    faces.push(mesh.hFace[h] as number);
    const across = (mesh.hPrev[h] as number) ^ 1;
    if ((mesh.hFace[across] as number) === NONE) {
      edges.push((mesh.hPrev[h] as number) >> 1);
      break;
    }
    h = across;
    if (h === first) {
      closed = true;
      break;
    }
  }
  return { edges, faces, closed };
}

function other(mesh: EditMesh, e: number, v: number): Tuple3 {
  const [a, b] = mesh.edgeVertices(e);
  return mesh.position(a === v ? b : a);
}

/** Sine table of the n-th roots of unity, exactly odd (S[n - d] = -S[d]) so mirrored rings agree bit for bit. */
function sineTable(n: number): number[] {
  const table = new Array<number>(n).fill(0);
  for (let d = 1; 2 * d < n; d++) {
    const value = sin((2 * Math.PI * d) / n);
    table[d] = value;
    table[n - d] = -value;
  }
  return table;
}

/**
 * Cross product of the two Halstead limit tangents of a valence-n ring, `edge` and `face`
 * being the once-refined edge and face points around it (face i between edge i and i + 1).
 * The tangents weight edge i by A_n cos(2 pi i / n) and face i by cos(2 pi i / n) +
 * cos(2 pi (i + 1) / n) (sines for the second), with the Halstead constant
 * A_n = 1 + cos(2 pi / n) + cos(pi / n) sqrt(2 (9 + cos(2 pi / n))). Expanding the cross
 * product leaves pair coefficients that depend only on the index offset, so the vector does
 * not depend on which edge starts the ring, and reversing the ring negates every coefficient
 * together with its cross product: a mirrored cage gives a bitwise mirrored normal.
 */
function tangentCross(edge: readonly Tuple3[], face: readonly Tuple3[]): Tuple3 {
  const n = edge.length;
  const turn = cos((2 * Math.PI) / n);
  const halstead = 1 + turn + cos(Math.PI / n) * Math.sqrt(2 * (9 + turn));
  const table = sineTable(n);
  const sn = (d: number): number => table[((d % n) + n) % n] as number;
  const points = [...edge, ...face];
  const terms: [number, Tuple3][] = [];
  for (let p = 0; p < 2 * n; p++) {
    const a = points[p] as Tuple3;
    for (let q = p + 1; q < 2 * n; q++) {
      const b = points[q] as Tuple3;
      let weight: number;
      if (q < n) weight = halstead * halstead * sn(q - p);
      else if (p < n) weight = halstead * exactSum([sn(q - n - p), sn(q - n + 1 - p)]);
      else {
        const d = q - p;
        weight = exactSum([2 * sn(d), sn(d + 1), sn(d - 1)]);
      }
      terms.push([
        weight,
        [
          (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number),
          (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number),
          (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number),
        ],
      ]);
    }
  }
  return combine(terms, 1);
}

function smoothLimit(
  p: Tuple3,
  w: readonly Tuple3[],
  f: readonly Tuple3[],
  wantNormal: boolean,
): { position: Tuple3; normal: Tuple3 } {
  const n = w.length;
  const mid = w.map((q) =>
    combine(
      [
        [1, p],
        [1, q],
      ],
      2,
    ),
  );
  const vertexRule = combine(
    [
      ...f.map((q) => [1, q] as const),
      ...mid.map((q) => [2, q] as const),
      [(n - 3) * n, p] as const,
    ],
    n * n,
  );
  const edgePoint = w.map((q, i) =>
    combine(
      [
        [1, p],
        [1, q],
        [1, f[(i + n - 1) % n] as Tuple3],
        [1, f[i] as Tuple3],
      ],
      4,
    ),
  );
  const position = combine(
    [
      [n * n, vertexRule] as const,
      ...edgePoint.map((q) => [4, q] as const),
      ...f.map((q) => [1, q] as const),
    ],
    n * (n + 5),
  );
  if (!wantNormal) return { position, normal: [0, 0, 0] };
  const [x, y, z] = tangentCross(edgePoint, f);
  const length = hypot3(x, y, z);
  const normal: Tuple3 = length > 0 ? [x / length, y / length, z / length] : [0, 0, 0];
  return { position, normal };
}

/** Ring of a vertex while its half-sharp creases are refined away (the one-ring of a level). */
interface Ring {
  readonly p: Tuple3;
  /** Neighbour across each ring edge. */
  readonly w: readonly Tuple3[];
  /** Face point of the face between ring edge i and i + 1 (wraps on a closed fan). */
  readonly f: readonly Tuple3[];
  /** Crease sharpness of each ring edge. */
  readonly s: readonly number[];
  readonly closed: boolean;
}

const unit = (q: Tuple3): readonly [number, Tuple3] => [1, q];

/**
 * One Catmull-Clark level of the one-ring around a vertex with DeRose semi-sharp rules (the
 * same rules as `subdivide`). The refined ring is the edge points (neighbours) and the face
 * points (their quads' far corners), so every level follows from the previous ring alone.
 */
function refineRing(r: Ring): Ring {
  const n = r.w.length;
  const faces = r.f.length;
  const edgePoint = r.w.map((q, i) => {
    const hard = Math.min(1, r.s[i] as number);
    const mid = combine([unit(r.p), unit(q)], 2);
    if (hard >= 1) return mid;
    const smooth = combine(
      [
        unit(r.p),
        unit(q),
        unit(r.f[(i + faces - 1) % faces] as Tuple3),
        unit(r.f[i % faces] as Tuple3),
      ],
      4,
    );
    return hard > 0
      ? combine(
          [
            [1 - hard, smooth],
            [hard, mid],
          ],
          1,
        )
      : smooth;
  });
  const sharpEdges = r.s
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > 0)
    .sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  const { crease: a, corner: b } = creaseWeights(sharpEdges.map(([s]) => s));
  let p: Tuple3 = r.p;
  if (b < 1) {
    const smooth = (): Tuple3 =>
      combine(
        [
          ...r.f.map(unit),
          ...r.w.map((q) => [2, combine([unit(r.p), unit(q)], 2)] as const),
          [(n - 3) * n, r.p] as const,
        ],
        n * n,
      );
    const crease = (): Tuple3 => {
      const [x, y] = sharpEdges.slice(0, 2).map(([, i]) => r.w[i] as Tuple3) as [Tuple3, Tuple3];
      return combine([unit(x), [6, r.p], unit(y)], 8);
    };
    if (a >= 1 && b <= 0) p = crease();
    else if (a <= 0) p = smooth();
    else {
      p = combine(
        [
          ...(a < 1 ? [[1 - a, smooth()] as const] : []),
          ...(a > b ? [[a - b, crease()] as const] : []),
          [b, r.p] as const,
        ],
        1,
      );
    }
  }
  const f = r.f.map((_, i) =>
    combine(
      [
        unit(p),
        unit(edgePoint[i] as Tuple3),
        unit(r.f[i] as Tuple3),
        unit(edgePoint[(i + 1) % n] as Tuple3),
      ],
      4,
    ),
  );
  return { p, w: edgePoint, f, s: r.s.map((x) => Math.max(0, x - 1)), closed: r.closed };
}

/**
 * Limit positions and normals of the Catmull-Clark surface a cage defines, in closed form:
 * Tangent masks on the once-refined one-ring (positions) and the cosine/sine
 * tangent masks (normals), so no refinement runs and the cost is linear in the face corners.
 * Crease rules match `subdivide`: a half-sharp crease is refined away on its one-ring first (one level per unit of
 * sharpness, at most ten), then the closed-form mask of the resulting ring applies. Every sum is exact-then-rounded, so a mirrored cage gives
 * bitwise mirrored limit points whatever its vertex or face order.
 */
export function subdivisionLimit(
  mesh: EditMesh,
  options: LimitOptions = {},
): Result<LimitSurface, ModelingError> {
  const boundary = options.boundary ?? 'edgeAndCorner';
  const fallback = options.creaseSharpness ?? Infinity;
  if (typeof fallback !== 'number' || Number.isNaN(fallback) || fallback <= 0) {
    return err(
      modelingError('model-invalid-argument', 'creaseSharpness is greater than 0', {
        creaseSharpness: fallback,
      }),
    );
  }
  if (boundary !== 'edgeOnly' && boundary !== 'edgeAndCorner') {
    return err(
      modelingError('model-invalid-argument', 'boundary is one of edgeOnly, edgeAndCorner', {
        boundary,
      }),
    );
  }
  const corners = new Int32Array(mesh.vertexHighWater).fill(NONE);
  const count = new Int32Array(mesh.vertexHighWater);
  let total = 0;
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const v = mesh.hVert[h] as number;
      if ((corners[v] as number) === NONE) corners[v] = h;
      count[v] = (count[v] as number) + 1;
      total++;
    }
  }
  const budget = options.budget;
  if (budget !== undefined && total * UNITS_PER_CORNER > budget) {
    return err(
      modelingError(
        'model-work-budget',
        `the limit query stays within ${budget} work units`,
        { corners: total, units: total * UNITS_PER_CORNER },
        'evaluate fewer vertices or raise the declared budget',
      ),
    );
  }
  let ids: number[];
  if (options.vertices === undefined) {
    ids = mesh.vertices().filter((v) => (corners[v] as number) !== NONE);
  } else {
    const wanted = [...new Set(options.vertices)].sort((a, b) => a - b);
    const bad = wanted.filter((v) => !mesh.isVertexAlive(v) || (corners[v] as number) === NONE);
    if (bad.length > 0) {
      return err(
        modelingError('model-invalid-argument', 'every vertex id is alive and used by a face', {
          vertices: bad.slice(0, 32),
        }),
      );
    }
    ids = wanted;
  }
  const position = new Float64Array(ids.length * 3);
  const normal = new Float64Array(ids.length * 3);
  const valence = new Int32Array(ids.length);
  const kind: LimitKind[] = [];
  const broken: { vertex: number; reason: string }[] = [];
  for (const [i, v] of ids.entries()) {
    const fan = walkFan(mesh, corners[v] as number);
    if (fan === undefined || fan.faces.length !== (count[v] as number)) {
      broken.push({ vertex: v, reason: 'non-manifold' });
      continue;
    }
    const n = fan.edges.length;
    valence[i] = n;
    const p = mesh.position(v);
    if (fan.closed && n < 3) {
      broken.push({ vertex: v, reason: 'valence' });
      continue;
    }
    const sharp = fan.edges.map((e) => edgeSharpness(mesh, e, fallback));
    const creases = sharp.filter((x) => x > 0).length;
    const pinned =
      creases === 2 && boundary === 'edgeAndCorner' && fan.faces.length === 1 && !fan.closed;
    let ring: Ring = {
      p,
      w: fan.edges.map((e) => other(mesh, e, v)),
      f: fan.faces.map((face) => facePoint(mesh, face)),
      s: sharp,
      closed: fan.closed,
    };
    if (!pinned) {
      while (ring.s.some((x) => x > 0 && x < Infinity)) ring = refineRing(ring);
    }
    const infinite = pinned ? 3 : ring.s.filter((x) => x > 0).length;
    if (infinite === 1) {
      broken.push({ vertex: v, reason: 'dart' });
      continue;
    }
    const kindOf: LimitKind = infinite === 0 ? 'smooth' : infinite === 2 ? 'crease' : 'corner';
    kind.push(kindOf);
    let at: Tuple3 = p;
    let up: Tuple3 = [0, 0, 0];
    if (kindOf === 'smooth') {
      const limit = smoothLimit(ring.p, ring.w, ring.f, true);
      at = limit.position;
      up = limit.normal;
    } else if (kindOf === 'crease') {
      const [a, b] = ring.w.filter((_, j) => (ring.s[j] as number) > 0) as [Tuple3, Tuple3];
      at = combine(
        [
          [1, a],
          [4, ring.p],
          [1, b],
        ],
        6,
      );
    } else {
      at = ring.p;
    }
    position.set(at, i * 3);
    normal.set(up, i * 3);
  }
  if (broken.length > 0) {
    return err(
      modelingError(
        'model-precondition',
        'every vertex has one manifold fan of at least three edges (or an open fan) and no lone crease end',
        { vertices: broken.slice(0, 32), count: broken.length },
        'merge or split the vertex, remove the two-edge pole, or extend or clear the dart crease, then repeat the query',
      ),
    );
  }
  return ok({ vertices: Int32Array.from(ids), position, normal, kind, valence });
}
