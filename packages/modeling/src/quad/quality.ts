import type { EditMesh } from '../mesh';

export interface QuadQuality {
  /** Quad faces over the measured faces. */
  readonly quadRatio: number;
  /** L4 scaled Jacobian summary over triangles and quads only. */
  readonly scaledJacobian: { readonly min: number; readonly mean: number };
  /** Interior vertices whose valence is not 4 in the measured face region. */
  readonly interiorNon4Valence: number;
  /** Edges with exactly one incident measured face. */
  readonly boundaryEdges: number;
  /** Measured faces that are not quads. */
  readonly nonQuadFaces: number;
}

/** Quality of `faces`, defaulting to the whole mesh. */
export function qualityOf(mesh: EditMesh, faceIds: Iterable<number> = mesh.faces()): QuadQuality {
  const faces = [...faceIds].filter((f) => mesh.isFaceAlive(f));
  const faceSet = new Set(faces);
  const diag = diagonal(mesh.vertices().map((v) => mesh.position(v)));
  let quads = 0;
  const jacobians: number[] = [];
  const edgeFaces = new Map<number, { a: number; b: number; count: number }>();
  for (const f of faces) {
    const loop = mesh.faceHalves(f);
    const vertices = loop.map((h) => mesh.hVert[h] as number);
    const elementPoints = vertices.map((v) => mesh.position(v));
    if (loop.length === 4) quads++;
    if (loop.length <= 4) jacobians.push(scaledJacobian(elementPoints, vertices, diag));
    for (const h of loop) {
      const edge = h >> 1;
      const current = edgeFaces.get(edge);
      if (current === undefined) {
        edgeFaces.set(edge, {
          a: mesh.hVert[h] as number,
          b: mesh.hVert[mesh.hNext[h] as number] as number,
          count: 1,
        });
      } else current.count++;
    }
  }

  let boundary = 0;
  const valence = new Map<number, Set<number>>();
  const onBoundary = new Set<number>();
  for (const { a, b, count } of edgeFaces.values()) {
    if (count === 1) {
      boundary++;
      onBoundary.add(a);
      onBoundary.add(b);
    }
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const set = valence.get(x) ?? new Set<number>();
      set.add(y);
      valence.set(x, set);
    }
  }
  let nonFour = 0;
  const vertices = new Set<number>();
  for (const f of faceSet) for (const v of mesh.faceVertices(f)) vertices.add(v);
  for (const v of vertices) {
    if (onBoundary.has(v)) continue;
    const degree = valence.get(v)?.size ?? 0;
    if (degree > 0 && degree !== 4) nonFour++;
  }
  return {
    quadRatio: faces.length === 0 ? 0 : quads / faces.length,
    scaledJacobian: summarize(jacobians),
    interiorNon4Valence: nonFour,
    boundaryEdges: boundary,
    nonQuadFaces: faces.length - quads,
  };
}

/** L4 corner scaled Jacobian: min corner sine, zero for a degenerate element. */
export function scaledJacobian(
  points: readonly [number, number, number][],
  vertices: readonly number[],
  diag: number,
): number {
  const n = points.length;
  if (new Set(vertices).size !== n) return 0;
  let newellX = 0;
  let newellY = 0;
  let newellZ = 0;
  const edgeLengths: number[] = [];
  for (let i = 0; i < n; i++) {
    if (vertices[i] === vertices[(i + 1) % n]) return 0;
    const p = points[i] as [number, number, number];
    const q = points[(i + 1) % n] as [number, number, number];
    newellX += p[1] * q[2] - p[2] * q[1];
    newellY += p[2] * q[0] - p[0] * q[2];
    newellZ += p[0] * q[1] - p[1] * q[0];
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const dz = q[2] - p[2];
    edgeLengths.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  const area2 = Math.sqrt(newellX * newellX + newellY * newellY + newellZ * newellZ);
  if (edgeLengths.some((length) => length <= 1e-12 * diag) || area2 <= 2e-12 * diag * diag)
    return 0;
  const normal: [number, number, number] = [newellX / area2, newellY / area2, newellZ / area2];
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const at = points[i] as [number, number, number];
    const next = points[(i + 1) % n] as [number, number, number];
    const previous = points[(i + n - 1) % n] as [number, number, number];
    const a = unit([next[0] - at[0], next[1] - at[1], next[2] - at[2]]);
    const b = unit([previous[0] - at[0], previous[1] - at[1], previous[2] - at[2]]);
    const cross: [number, number, number] = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    min = Math.min(min, cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2]);
  }
  return Number.isFinite(min) ? min : 0;
}

function summarize(values: readonly number[]): { min: number; mean: number } {
  if (values.length === 0) return { min: 0, mean: 0 };
  let min = Infinity;
  let sum = 0;
  for (const value of values) {
    min = Math.min(min, value);
    sum += value;
  }
  return { min, mean: sum / values.length };
}

function diagonal(points: readonly (readonly [number, number, number])[]): number {
  if (points.length === 0) return 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i] as number, p[i] as number);
      max[i] = Math.max(max[i] as number, p[i] as number);
    }
  const dx = (max[0] as number) - (min[0] as number);
  const dy = (max[1] as number) - (min[1] as number);
  const dz = (max[2] as number) - (min[2] as number);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function unit(v: readonly [number, number, number]): [number, number, number] {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
}
