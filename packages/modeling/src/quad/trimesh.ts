// Plain indexed triangle mesh used by the field stages, with the half-edge topology they need.
// Half-edge h = 3 t + k runs from triangles[3t+k] to triangles[3t+(k+1)%3].

import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, cos } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { EditMesh } from '../mesh';

export interface TriMesh {
  /** x, y, z per vertex. */
  readonly positions: Float64Array;
  /** Three vertex ids per triangle, counterclockwise about the outward normal. */
  readonly triangles: Uint32Array;
}

export interface TriTopology {
  readonly vertexCount: number;
  readonly faceCount: number;
  /** Opposite half-edge, or -1 on a boundary. */
  readonly twin: Int32Array;
  /** Outgoing half-edges of each vertex in counterclockwise order: `ringStart[v]..ringStart[v+1]` into `ring`. */
  readonly ringStart: Uint32Array;
  readonly ring: Uint32Array;
  /** 1 for a vertex on a boundary edge. */
  readonly boundary: Uint8Array;
  readonly closed: boolean;
  /** V - E + F over referenced vertices. */
  readonly chi: number;
}

export type Vec3 = [number, number, number];

/** Inputs farther than this many bounding diagonals from the origin fail closed (design section 5). */
const RANGE = 1048576;
/** A triangle with |cross| at or below this times diag^2 is degenerate. */
const DEGENERATE_AREA = 9.094947017729282e-13;

export function vec(values: Float64Array, i: number): Vec3 {
  const o = 3 * i;
  return [values[o] as number, values[o + 1] as number, values[o + 2] as number];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function norm3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}

export function unit3(a: Vec3): Vec3 {
  const l = norm3(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export function corner(mesh: TriMesh, h: number): number {
  return mesh.triangles[h] as number;
}

export function nextHalfedge(h: number): number {
  return h % 3 === 2 ? h - 2 : h + 1;
}

export function prevHalfedge(h: number): number {
  return h % 3 === 0 ? h + 2 : h - 1;
}

export function headOf(mesh: TriMesh, h: number): number {
  return mesh.triangles[nextHalfedge(h)] as number;
}

export function diagonal(mesh: TriMesh): number {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const k = i % 3;
    const c = mesh.positions[i] as number;
    if (c < (lo[k] as number)) lo[k] = c;
    if (c > (hi[k] as number)) hi[k] = c;
  }
  return norm3(sub3(hi, lo));
}

/** Triangle mesh of an EditMesh; every face must already be a triangle. */
export function triMeshFromEdit(mesh: EditMesh): Result<TriMesh, ModelingError> {
  const ids = new Map<number, number>();
  const positions: number[] = [];
  const triangles: number[] = [];
  for (const f of mesh.faces()) {
    const loop = mesh.faceVertices(f);
    if (loop.length !== 3)
      return err(
        modelingError('model-precondition', 'every face is a triangle', {
          reason: 'not-triangle',
          face: f,
          sides: loop.length,
        }),
      );
    for (const v of loop) {
      let id = ids.get(v);
      if (id === undefined) {
        id = ids.size;
        ids.set(v, id);
        const p = mesh.position(v);
        positions.push(p[0], p[1], p[2]);
      }
      triangles.push(id);
    }
  }
  return ok({ positions: new Float64Array(positions), triangles: new Uint32Array(triangles) });
}

/** Validate coordinates, triangle areas and manifoldness, then build the half-edge topology. */
export function triTopology(mesh: TriMesh): Result<TriTopology, ModelingError> {
  const vertexCount = mesh.positions.length / 3;
  const faceCount = mesh.triangles.length / 3;
  if (!Number.isInteger(vertexCount) || !Number.isInteger(faceCount) || faceCount === 0)
    return err(
      modelingError('model-invalid-argument', 'positions has 3n and triangles 3m > 0 entries', {
        reason: 'bad-array-length',
      }),
    );
  for (let i = 0; i < mesh.positions.length; i++)
    if (!Number.isFinite(mesh.positions[i] as number))
      return err(
        modelingError('model-invalid-argument', 'finite coordinates', {
          reason: 'non-finite',
          vertex: Math.floor(i / 3),
        }),
      );
  const diag = diagonal(mesh);
  if (!(diag > 0))
    return err(
      modelingError('model-degenerate', 'a mesh with positive extent', { reason: 'zero-extent' }),
    );
  const range = rangeIssue(mesh, diag);
  if (range !== null) return err(range);
  for (let t = 0; t < faceCount; t++) {
    const a = mesh.triangles[3 * t] as number,
      b = mesh.triangles[3 * t + 1] as number,
      c = mesh.triangles[3 * t + 2] as number;
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount)
      return err(
        modelingError('model-invalid-argument', 'vertex ids in range', {
          reason: 'index-out-of-range',
          face: t,
        }),
      );
    const area2 = norm3(
      cross3(
        sub3(vec(mesh.positions, b), vec(mesh.positions, a)),
        sub3(vec(mesh.positions, c), vec(mesh.positions, a)),
      ),
    );
    if (a === b || b === c || a === c || area2 <= DEGENERATE_AREA * diag * diag)
      return err(
        modelingError('model-degenerate', 'triangles with positive area', {
          reason: 'degenerate-triangle',
          face: t,
        }),
      );
  }
  const twin = new Int32Array(3 * faceCount).fill(-1);
  const directed = new Map<number, number>();
  for (let h = 0; h < 3 * faceCount; h++) {
    const a = mesh.triangles[h] as number;
    const b = headOf(mesh, h);
    const key = a * vertexCount + b;
    if (directed.has(key))
      return err(
        modelingError('model-precondition', 'a consistently oriented manifold mesh', {
          reason: 'non-manifold-edge',
          edge: [a, b],
        }),
      );
    directed.set(key, h);
  }
  let edges = 0;
  for (let h = 0; h < 3 * faceCount; h++) {
    const a = mesh.triangles[h] as number;
    const b = headOf(mesh, h);
    const o = directed.get(b * vertexCount + a);
    if (o !== undefined) twin[h] = o;
    if (o === undefined || a < b) edges++;
  }
  const out: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let h = 0; h < 3 * faceCount; h++) (out[mesh.triangles[h] as number] as number[]).push(h);
  const boundary = new Uint8Array(vertexCount);
  const ringStart = new Uint32Array(vertexCount + 1);
  const ring: number[] = [];
  let referenced = 0;
  for (let v = 0; v < vertexCount; v++) {
    ringStart[v] = ring.length;
    const hs = out[v] as number[];
    if (hs.length === 0) continue;
    referenced++;
    let start = hs[0] as number;
    for (const h of hs)
      if (twin[h] === -1) {
        start = h;
        boundary[v] = 1;
      }
    const order: number[] = [];
    let h = start;
    do {
      order.push(h);
      const back = twin[prevHalfedge(h)] as number;
      if (back === -1) break;
      h = back;
    } while (h !== start && order.length <= hs.length);
    if (order.length !== hs.length)
      return err(
        modelingError('model-precondition', 'a manifold vertex (one fan of triangles)', {
          reason: 'non-manifold-vertex',
          vertex: v,
        }),
      );
    for (const x of order) ring.push(x);
  }
  ringStart[vertexCount] = ring.length;
  const closed = !twin.includes(-1);
  return ok({
    vertexCount,
    faceCount,
    twin,
    ringStart,
    ring: new Uint32Array(ring),
    boundary,
    closed,
    chi: referenced - edges + faceCount,
  });
}

// Distance from the origin, not the centroid: coordinates far from the origin relative to the mesh
// size lose the relative precision the angle and area computations rely on.
function rangeIssue(mesh: TriMesh, diag: number): ModelingError | null {
  const n = mesh.positions.length / 3;
  for (let v = 0; v < n; v++)
    if (norm3(vec(mesh.positions, v)) > RANGE * diag)
      return modelingError(
        'model-invalid-argument',
        'coordinates within 2^20 diagonals of the origin',
        {
          reason: 'out-of-range',
          range: { vertex: v, diag },
        },
      );
  return null;
}

/** Unit normal of each triangle, 3 numbers per triangle. */
export function faceNormals(mesh: TriMesh): Float64Array {
  const faceCount = mesh.triangles.length / 3;
  const normals = new Float64Array(3 * faceCount);
  for (let t = 0; t < faceCount; t++) {
    const n = unit3(triangleCross(mesh, t));
    normals.set(n, 3 * t);
  }
  return normals;
}

export function triangleCross(mesh: TriMesh, t: number): Vec3 {
  const a = vec(mesh.positions, mesh.triangles[3 * t] as number);
  const b = vec(mesh.positions, mesh.triangles[3 * t + 1] as number);
  const c = vec(mesh.positions, mesh.triangles[3 * t + 2] as number);
  return cross3(sub3(b, a), sub3(c, a));
}

export function faceAreas(mesh: TriMesh): Float64Array {
  const faceCount = mesh.triangles.length / 3;
  const areas = new Float64Array(faceCount);
  for (let t = 0; t < faceCount; t++) areas[t] = norm3(triangleCross(mesh, t)) / 2;
  return areas;
}

/** Interior angle of the triangle at the tail of half-edge h. */
export function cornerAngle(mesh: TriMesh, h: number): number {
  const p = vec(mesh.positions, corner(mesh, h));
  const a = sub3(vec(mesh.positions, headOf(mesh, h)), p);
  const b = sub3(vec(mesh.positions, corner(mesh, prevHalfedge(h))), p);
  return atan2(norm3(cross3(a, b)), dot3(a, b));
}

/** Angle defect 2 pi - sum of corner angles at each interior vertex; boundary vertices get 0. */
export function angleDefects(mesh: TriMesh, topo: TriTopology): Float64Array {
  const defects = new Float64Array(topo.vertexCount);
  for (let v = 0; v < topo.vertexCount; v++) {
    if (topo.boundary[v] === 1 || topo.ringStart[v] === topo.ringStart[v + 1]) continue;
    let sum = 0;
    for (let i = topo.ringStart[v] as number; i < (topo.ringStart[v + 1] as number); i++)
      sum += cornerAngle(mesh, topo.ring[i] as number);
    defects[v] = 2 * Math.PI - sum;
  }
  return defects;
}

export interface FeatureOptions {
  /** Dihedral angle in degrees above which an edge is a feature (default 30, as L3 `quadRemesh`). */
  readonly sharpDegrees?: number;
  /** Extra feature edges as vertex-id pairs (author crease intent). */
  readonly edges?: readonly (readonly [number, number])[];
}

/**
 * Feature mark per half-edge (both half-edges of an edge agree). Boundary edges are features.
 * A pair in `options.edges` that is not a mesh edge fails as `model-invalid-argument`.
 */
export function featureEdges(
  mesh: TriMesh,
  topo: TriTopology,
  options: FeatureOptions = {},
): Result<Uint8Array, ModelingError> {
  const degrees = options.sharpDegrees ?? 30;
  if (!(degrees >= 0 && degrees <= 180))
    return err(
      modelingError('model-invalid-argument', 'sharpDegrees in [0, 180]', {
        reason: 'bad-sharp-degrees',
        sharpDegrees: degrees,
      }),
    );
  const normals = faceNormals(mesh);
  const threshold = cos((degrees * Math.PI) / 180);
  const marks = new Uint8Array(3 * topo.faceCount);
  for (let h = 0; h < marks.length; h++) {
    const o = topo.twin[h] as number;
    if (o === -1) {
      marks[h] = 1;
      continue;
    }
    const f = Math.floor(h / 3);
    const g = Math.floor(o / 3);
    if (dot3(vec(normals, f), vec(normals, g)) < threshold) marks[h] = 1;
  }
  if (options.edges !== undefined) {
    const lookup = new Map<number, number>();
    for (let h = 0; h < marks.length; h++)
      lookup.set((mesh.triangles[h] as number) * topo.vertexCount + headOf(mesh, h), h);
    const id = (v: number) => Number.isInteger(v) && v >= 0 && v < topo.vertexCount;
    for (const [a, b] of options.edges) {
      // Out-of-range ids would alias another edge's a * V + b key.
      const h =
        !id(a) || !id(b)
          ? undefined
          : (lookup.get(a * topo.vertexCount + b) ?? lookup.get(b * topo.vertexCount + a));
      if (h === undefined)
        return err(
          modelingError('model-invalid-argument', 'feature edges are mesh edges', {
            reason: 'unknown-feature-edge',
            edge: [a, b],
          }),
        );
      marks[h] = 1;
      const o = topo.twin[h] as number;
      if (o !== -1) marks[o] = 1;
    }
  }
  return ok(marks);
}
