import { atan2, cos, sin } from '../dmath';
import type { Tuple3 } from '../geom';
import type { FaceSelector } from '../selectors';

/**
 * The direction a remesh's long edges follow on a surface: a fixed direction
 * (`along`), circles about an axis (`around`), rays from a point (`from`) or the tangent of
 * the nearest point of a polyline (`curve`). Each is projected onto the local tangent plane.
 */
export type Flow =
  | { readonly along: Tuple3 }
  | { readonly around: { readonly axis: Tuple3; readonly center: Tuple3 } }
  | { readonly from: Tuple3 }
  | { readonly curve: readonly Tuple3[] };

/** A flow over the faces `faces` selects (every face without it); the first guide covering a face wins. */
export interface FlowGuide {
  readonly faces?: FaceSelector;
  readonly flow: Flow;
  /** Remesh only: this guide's long over short edge length, instead of the direction's. */
  readonly anisotropy?: number;
  /**
   * meshQuality only: report the border rows apart. A border row is a measured triangle with
   * an edge on a structure line (open, sharp, or between labels or materials) that crosses
   * the flow by more than `crossing` degrees; such a triangle's longest edge is often the
   * border edge, whatever the remesh does.
   */
  readonly border?: { readonly crossing: number };
}

const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Tuple3) => Math.sqrt(dot(a, a));

/** `d` projected onto the plane of unit normal `n`, unit length, or undefined when it vanishes. */
export function tangent(d: Tuple3, n: Tuple3): Tuple3 | undefined {
  const k = dot(d, n);
  const t: Tuple3 = [d[0] - k * n[0], d[1] - k * n[1], d[2] - k * n[2]];
  const l = norm(t);
  return l > 1e-12 ? [t[0] / l, t[1] / l, t[2] / l] : undefined;
}

/** The flow's tangent direction at point `p` with unit normal `n` (undefined where it degenerates). */
export function flowAt(flow: Flow, p: Tuple3, n: Tuple3): Tuple3 | undefined {
  if ('along' in flow) return tangent(flow.along, n);
  if ('around' in flow) return tangent(cross(flow.around.axis, sub(p, flow.around.center)), n);
  if ('from' in flow) return tangent(sub(p, flow.from), n);
  const points = flow.curve;
  let best: Tuple3 | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Tuple3;
    const b = points[i + 1] as Tuple3;
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    if (l2 === 0) continue;
    const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
    const q: Tuple3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    const d = dot(sub(p, q), sub(p, q));
    if (d < bestDistance) {
      bestDistance = d;
      best = ab;
    }
  }
  return best === undefined ? undefined : tangent(best, n);
}

/** Angle in degrees between two line directions (mod 180, so at most 90). */
export function lineAngle(a: Tuple3, b: Tuple3): number {
  const c = Math.abs(dot(a, b)) / (norm(a) * norm(b) || 1);
  const k = Math.min(1, c);
  return (atan2(Math.sqrt(1 - k * k), k) * 180) / Math.PI;
}

/** Solution of the 3 x 3 system A x = r (row-major), or undefined when it is singular. */
function solve3(A: readonly number[], r: readonly number[]): number[] | undefined {
  const m = A.map((x) => x);
  const b = r.map((x) => x);
  for (let c = 0; c < 3; c++) {
    let pivot = c;
    for (let i = c + 1; i < 3; i++)
      if (Math.abs(m[i * 3 + c] as number) > Math.abs(m[pivot * 3 + c] as number)) pivot = i;
    if (Math.abs(m[pivot * 3 + c] as number) < 1e-12) return undefined;
    for (let k = 0; k < 3; k++) {
      const t = m[c * 3 + k] as number;
      m[c * 3 + k] = m[pivot * 3 + k] as number;
      m[pivot * 3 + k] = t;
    }
    const t = b[c] as number;
    b[c] = b[pivot] as number;
    b[pivot] = t;
    for (let i = 0; i < 3; i++) {
      if (i === c) continue;
      const q = (m[i * 3 + c] as number) / (m[c * 3 + c] as number);
      for (let k = 0; k < 3; k++)
        m[i * 3 + k] = (m[i * 3 + k] as number) - q * (m[c * 3 + k] as number);
      b[i] = (b[i] as number) - q * (b[c] as number);
    }
  }
  return [0, 1, 2].map((c) => (b[c] as number) / (m[c * 3 + c] as number));
}

/** A tangent frame of unit normal n. */
function frame(n: Tuple3): [Tuple3, Tuple3] {
  const helper: Tuple3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const t1 = tangent(helper, n) as Tuple3;
  return [t1, cross(n, t1)];
}

/** Direction d (in the plane of the frame) as a unit vector of the doubled angle: lines agree mod pi. */
function doubled(d: Tuple3, [t1, t2]: [Tuple3, Tuple3]): [number, number] | undefined {
  const c = dot(d, t1);
  const s = dot(d, t2);
  const l2 = c * c + s * s;
  if (!(l2 > 1e-24)) return undefined;
  return [(c * c - s * s) / l2, (2 * c * s) / l2];
}

/** The line direction of a doubled-angle vector in the frame. */
function halved([x, y]: [number, number], [t1, t2]: [Tuple3, Tuple3]): Tuple3 {
  const theta = atan2(y, x) / 2;
  const c = cos(theta);
  const s = sin(theta);
  return [c * t1[0] + s * t2[0], c * t1[1] + s * t2[1], c * t1[2] + s * t2[2]];
}

export interface LineFieldInput {
  /** Vertex positions (x, y, z per vertex). */
  readonly positions: ArrayLike<number>;
  /** Triangles as vertex triples. */
  readonly triangles: ArrayLike<number>;
  /** Desired direction on a triangle (any length, projected per vertex), or undefined: no data. */
  readonly data?: (triangle: number, centroid: Tuple3, normal: Tuple3) => Tuple3 | undefined;
  /** Use the minimum principal curvature direction as data instead. */
  readonly principal?: boolean;
  /**
   * Hard constraints: at these edges' vertices (vertex pairs) the field runs along the edges,
   * or across them where the data is nearer the perpendicular.
   */
  readonly constraints?: readonly (readonly [number, number])[];
  /** Gauss-Seidel smoothing passes (default 30). */
  readonly iterations?: number;
  /** Weight of a vertex's data against one neighbour (default 4). */
  readonly dataWeight?: number;
}

export interface LineField {
  /** Unit tangent per vertex (0, 0, 0 where nothing reached it). */
  readonly field: Float64Array;
  readonly normals: Float64Array;
  /** Vertices fixed by constraint edges. */
  readonly constrained: number;
  /** Mean angle (degrees) between the field at the two ends of each edge: 0 is uniform. */
  readonly roughness: number;
}

/**
 * A smooth line field (direction mod pi) on a triangle mesh: data from the
 * caller's directions or principal curvature, hard constraints along edges, then local
 * averaging of doubled angles (the orientation phase of Instant Meshes for 2-RoSy).
 */
export function lineField(input: LineFieldInput): LineField {
  const P = input.positions;
  const T = input.triangles;
  const n = Math.floor(P.length / 3);
  const p = (v: number): Tuple3 => [
    P[v * 3] as number,
    P[v * 3 + 1] as number,
    P[v * 3 + 2] as number,
  ];
  const normals = new Float64Array(n * 3);
  const neighbours: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  const data: ([number, number] | undefined)[] = new Array(n).fill(undefined);
  const dataSum = Array.from({ length: n }, () => [0, 0] as [number, number]);
  const triangleCount = Math.floor(T.length / 3);
  const triangleData: (Tuple3 | undefined)[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const ids = [T[t * 3] as number, T[t * 3 + 1] as number, T[t * 3 + 2] as number];
    const [a, b, c] = ids.map(p) as [Tuple3, Tuple3, Tuple3];
    const face = cross(sub(b, a), sub(c, a));
    for (const v of ids) {
      for (let k = 0; k < 3; k++)
        normals[v * 3 + k] = (normals[v * 3 + k] as number) + (face[k] as number);
      for (const u of ids) if (u !== v) neighbours[v]?.add(u);
    }
    const l = norm(face);
    const unit: Tuple3 = l > 0 ? [face[0] / l, face[1] / l, face[2] / l] : [0, 0, 1];
    const centroid: Tuple3 = [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ];
    triangleData.push(input.data?.(t, centroid, unit));
  }
  const N = (v: number): Tuple3 => {
    const m: Tuple3 = [
      normals[v * 3] as number,
      normals[v * 3 + 1] as number,
      normals[v * 3 + 2] as number,
    ];
    const l = norm(m);
    return l > 0 ? [m[0] / l, m[1] / l, m[2] / l] : [0, 0, 1];
  };
  for (let v = 0; v < n; v++) {
    const m = N(v);
    normals.set(m, v * 3);
  }
  const frames = Array.from({ length: n }, (_, v) => frame(N(v)));
  for (let t = 0; t < triangleCount; t++) {
    const d = triangleData[t];
    if (d === undefined) continue;
    for (let k = 0; k < 3; k++) {
      const v = T[t * 3 + k] as number;
      const w = doubled(d, frames[v] as [Tuple3, Tuple3]);
      if (w === undefined) continue;
      const s = dataSum[v] as [number, number];
      s[0] += w[0];
      s[1] += w[1];
    }
  }
  if (input.principal === true) {
    // Normal curvature along each edge from the normal change, kappa(phi) fitted per vertex as
    // a + b cos 2phi + c sin 2phi (least squares, so a lopsided set of edge directions does not
    // bias it); (b, c) points at the maximum curvature, the minimum is its negation.
    for (let v = 0; v < n; v++) {
      const nv = N(v);
      const f = frames[v] as [Tuple3, Tuple3];
      const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      const r = [0, 0, 0];
      for (const u of neighbours[v] ?? []) {
        const e = sub(p(u), p(v));
        const l2 = dot(e, e);
        const w = doubled(e, f);
        if (l2 === 0 || w === undefined) continue;
        const kappa = dot(sub(N(u), nv), e) / l2;
        const row = [1, w[0], w[1]];
        for (let i = 0; i < 3; i++) {
          r[i] = (r[i] as number) + (row[i] as number) * kappa;
          for (let k = 0; k < 3; k++)
            A[i * 3 + k] = (A[i * 3 + k] as number) + (row[i] as number) * (row[k] as number);
        }
      }
      const x = solve3(A, r);
      if (x === undefined) continue;
      const s = dataSum[v] as [number, number];
      s[0] -= x[1] as number;
      s[1] -= x[2] as number;
    }
  }
  for (let v = 0; v < n; v++) {
    const s = dataSum[v] as [number, number];
    const l = Math.sqrt(s[0] * s[0] + s[1] * s[1]);
    if (l > 1e-12) data[v] = [s[0] / l, s[1] / l];
  }
  // Hard constraints: the doubled average of the constraint edges at a vertex.
  const fixed = new Map<number, [number, number]>();
  for (const [a, b] of input.constraints ?? []) {
    const e = sub(p(b), p(a));
    for (const v of [a, b]) {
      const w = doubled(e, frames[v] as [Tuple3, Tuple3]);
      if (w === undefined) continue;
      const s = fixed.get(v) ?? [0, 0];
      s[0] += w[0];
      s[1] += w[1];
      fixed.set(v, s);
    }
  }
  const field = new Float64Array(n * 3);
  const current: ([number, number] | undefined)[] = data.map((d) => d);
  for (const [v, s] of fixed) {
    const l = Math.sqrt(s[0] * s[0] + s[1] * s[1]);
    // Edges meeting at a right angle cancel: the corner stays free.
    if (!(l > 1e-6)) {
      fixed.delete(v);
      continue;
    }
    // A border can carry long edges along it or end them across it: the field takes whichever
    // of the border direction and its perpendicular (opposite in doubled angles) is nearer the
    // data, so a flow crossing a border (meridians at a dome's rim) is not turned along it.
    const along: [number, number] = [s[0] / l, s[1] / l];
    const d = data[v];
    const across = d !== undefined && along[0] * d[0] + along[1] * d[1] < 0;
    current[v] = across ? [-along[0], -along[1]] : along;
  }
  const weight = input.dataWeight ?? 4;
  const passes = input.iterations ?? 30;
  // Directions live in each vertex's own frame; a neighbour's is carried over in 3D.
  const world = (v: number): Tuple3 | undefined => {
    const c = current[v];
    return c === undefined ? undefined : halved(c, frames[v] as [Tuple3, Tuple3]);
  };
  for (let pass = 0; pass < passes; pass++) {
    for (let v = 0; v < n; v++) {
      if (fixed.has(v)) continue;
      const f = frames[v] as [Tuple3, Tuple3];
      const d = data[v];
      let x = d === undefined ? 0 : weight * d[0];
      let y = d === undefined ? 0 : weight * d[1];
      for (const u of neighbours[v] ?? []) {
        const wu = world(u);
        if (wu === undefined) continue;
        const w = doubled(wu, f);
        if (w === undefined) continue;
        x += w[0];
        y += w[1];
      }
      const l = Math.sqrt(x * x + y * y);
      if (l > 1e-12) current[v] = [x / l, y / l];
    }
  }
  for (let v = 0; v < n; v++) {
    const w = world(v);
    if (w !== undefined) field.set(w, v * 3);
  }
  // Roughness compares a neighbour's direction carried into each vertex's tangent plane, so a
  // field turning with the surface (circles on a cylinder) is smooth.
  let total = 0;
  let edges = 0;
  for (let v = 0; v < n; v++) {
    const a: Tuple3 = [
      field[v * 3] as number,
      field[v * 3 + 1] as number,
      field[v * 3 + 2] as number,
    ];
    for (const u of neighbours[v] ?? []) {
      if (u < v) continue;
      const b: Tuple3 = [
        field[u * 3] as number,
        field[u * 3 + 1] as number,
        field[u * 3 + 2] as number,
      ];
      const carried = norm(a) === 0 || norm(b) === 0 ? undefined : tangent(b, N(v));
      if (carried === undefined) continue;
      total += lineAngle(a, carried);
      edges++;
    }
  }
  return { field, normals, constrained: fixed.size, roughness: edges === 0 ? 0 : total / edges };
}
