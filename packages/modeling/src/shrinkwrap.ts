import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from './arrays';
import { LEGACY_BVH, TriangleBvh } from './compute/bvh';
import { applyDeformation } from './deform';
import { atan2 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { checkFalloff, type Falloff, falloffWeights } from './falloff';
import {
  add,
  cross,
  dot,
  length,
  newell,
  normalize,
  scale,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import type { EditMesh } from './mesh';
import type { OpDiagnostic, RoleCounts } from './ops';

/** How a wrapped vertex finds its surface point. */
export type ShrinkwrapMode = 'nearest' | 'project';

export interface ShrinkwrapOptions {
  /**
   * `nearest` (default): the surface point along the normal of the closest point;
   * `project`: the nearest hit along `direction`, both ways.
   */
  readonly mode?: ShrinkwrapMode;
  /** `project` only: a world direction, or `normal` (default), each vertex's own normal. */
  readonly direction?: Tuple3 | 'normal';
  /** Signed distance from the surface along its interpolated outward normal (default 0). */
  readonly offset?: number;
  /** Vertices farther from the surface (or with no hit) stay and are reported (default unlimited). */
  readonly maxDistance?: number;
  /** Soft blend: unselected vertices within the radius move by their falloff weight. */
  readonly falloff?: Falloff;
}

/** A surface point with its interpolated outward unit normal and the face it lies on. */
export interface SurfacePoint {
  readonly point: Tuple3;
  readonly normal: Tuple3;
  readonly distance: number;
  readonly face: number;
}

/**
 * Closest-point and ray queries against faces of a mesh: the faces' export
 * triangulation in a TriangleBvh, with angle-weighted vertex normals interpolated
 * barycentrically, so offsets follow a faceted surface without steps at its edges.
 * Positions are copied: later edits of the mesh do not move the query surface.
 */
export class SurfaceQuery {
  private readonly bvh: TriangleBvh;
  private normals:
    | { readonly vertices: Float64Array; readonly triangles: readonly Tuple3[] }
    | undefined;

  private readonly positions: Float64Array;
  private readonly indices: Int32Array;
  /** Source face of every triangle. */
  private readonly faces: Int32Array;

  private constructor(positions: Float64Array, indices: Int32Array, faces: Int32Array) {
    this.positions = positions;
    this.indices = indices;
    this.faces = faces;
    this.bvh = new TriangleBvh(positions, indices, LEGACY_BVH);
  }

  private surfaceNormals() {
    if (this.normals !== undefined) return this.normals;
    const { positions, indices } = this;
    const vertices = new Float64Array(positions.length);
    const triangles: Tuple3[] = [];
    const at = (i: number): Tuple3 => [
      positions[i * 3] as number,
      positions[i * 3 + 1] as number,
      positions[i * 3 + 2] as number,
    ];
    for (let t = 0; t < indices.length; t += 3) {
      const ids = [indices[t], indices[t + 1], indices[t + 2]] as [number, number, number];
      const [a, b, c] = ids.map(at) as [Tuple3, Tuple3, Tuple3];
      const n = normalize(cross(sub(b, a), sub(c, a)));
      triangles.push(n);
      for (let k = 0; k < 3; k++) {
        const here = at(ids[k] as number);
        const next = sub(at(ids[(k + 1) % 3] as number), here);
        const prev = sub(at(ids[(k + 2) % 3] as number), here);
        const angle = atan2(length(cross(next, prev)), dot(next, prev));
        for (let c = 0; c < 3; c++) {
          vertices[(ids[k] as number) * 3 + c] =
            (vertices[(ids[k] as number) * 3 + c] as number) + (n[c] as number) * angle;
        }
      }
    }
    this.normals = { vertices, triangles };
    return this.normals;
  }

  /** The surface of `faces`; `model-precondition` when none of them triangulates. */
  static of(mesh: EditMesh, faces: readonly number[]): Result<SurfaceQuery, ModelingError> {
    const index = new Map<number, number>();
    const positions: number[] = [];
    const indices: number[] = [];
    const owners: number[] = [];
    for (const f of faces) {
      const loop = mesh.faceVertices(f);
      const triangles = triangulateLoop(loop.map((v) => mesh.position(v)));
      if (triangles === undefined) continue;
      for (const k of triangles) {
        const v = loop[k] as number;
        let i = index.get(v);
        if (i === undefined) {
          i = index.size;
          index.set(v, i);
          pushAll(positions, mesh.position(v));
        }
        indices.push(i);
      }
      for (let t = 0; t < triangles.length; t += 3) owners.push(f);
    }
    if (indices.length === 0) {
      return err(
        modelingError('model-precondition', 'the target surface has at least one valid face', {
          faces: faces.length,
        }),
      );
    }
    return ok(
      new SurfaceQuery(
        Float64Array.from(positions),
        Int32Array.from(indices),
        Int32Array.from(owners),
      ),
    );
  }

  private surfacePoint(triangle: number, u: number, v: number, distance: number): SurfacePoint {
    const normals = this.surfaceNormals();
    const ids = [0, 1, 2].map((k) => this.indices[triangle * 3 + k] as number);
    const weights = [1 - u - v, u, v];
    const point: Tuple3 = [0, 0, 0];
    let normal: Tuple3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const i = ids[k] as number;
      const w = weights[k] as number;
      for (let c = 0; c < 3; c++) {
        point[c] = (point[c] as number) + (this.positions[i * 3 + c] as number) * w;
        normal[c] = (normal[c] as number) + (normals.vertices[i * 3 + c] as number) * w;
      }
    }
    normal = normalize(normal);
    if (length(normal) === 0) normal = normals.triangles[triangle] as Tuple3;
    return { point, normal, distance, face: this.faces[triangle] as number };
  }

  /** True when a ray from `p` along `direction` hits a face other than `face`. */
  occluded(p: Tuple3, direction: Tuple3, face: number): boolean {
    return (
      this.bvh.raycast(p, direction, Infinity, true, (t) => (this.faces[t] as number) !== face) !==
      undefined
    );
  }

  nearest(p: Tuple3): SurfacePoint | undefined {
    const hit = this.bvh.nearest(p);
    if (hit === undefined) return undefined;
    return this.surfacePoint(hit.triangle, hit.u, hit.v, Math.sqrt(hit.distanceSquared));
  }

  /**
   * The surface point under `p`: along the interpolated normal of its nearest point.
   * Points in the normal cone of a convex corner share that nearest point; following
   * the normal spreads them over the corner's faces instead of collapsing them.
   */
  below(p: Tuple3): SurfacePoint | undefined {
    const closest = this.nearest(p);
    if (closest === undefined) return undefined;
    const along = this.project(p, closest.normal, Infinity);
    return along === undefined || along.distance > closest.distance * 4 + 1e-9 ? closest : along;
  }

  /** The nearest hit along `direction` only. */
  cast(p: Tuple3, direction: Tuple3): SurfacePoint | undefined {
    const hit = this.bvh.raycast(p, direction, Infinity);
    return hit === undefined ? undefined : this.surfacePoint(hit.triangle, hit.u, hit.v, hit.t);
  }

  /** The nearest hit along `+direction` or `-direction` within `maxDistance` (forward on ties). */
  project(p: Tuple3, direction: Tuple3, maxDistance: number): SurfacePoint | undefined {
    const forward = this.bvh.raycast(p, direction, maxDistance);
    const backward = this.bvh.raycast(p, scale(direction, -1), maxDistance);
    const hit =
      forward === undefined || (backward !== undefined && backward.t < forward.t)
        ? backward
        : forward;
    if (hit === undefined) return undefined;
    return this.surfacePoint(hit.triangle, hit.u, hit.v, hit.t);
  }
}

/** Angle-weighted vertex normals of `mesh` at `vertices` over every incident face. */
function vertexNormals(mesh: EditMesh, vertices: ReadonlySet<number>): Map<number, Tuple3> {
  const sums = new Map<number, Tuple3>();
  for (const f of mesh.faces()) {
    const halves = mesh.faceHalves(f);
    if (!halves.some((h) => vertices.has(mesh.hVert[h] as number))) continue;
    const n = normalize(newell(mesh.faceVertices(f).map((v) => mesh.position(v))));
    for (const h of halves) {
      const v = mesh.hVert[h] as number;
      if (!vertices.has(v)) continue;
      const here = mesh.position(v);
      const prev = sub(mesh.position(mesh.hVert[mesh.hPrev[h] as number] as number), here);
      const next = sub(mesh.position(mesh.hVert[mesh.hNext[h] as number] as number), here);
      const angle = atan2(length(cross(next, prev)), dot(next, prev));
      sums.set(v, add(sums.get(v) ?? [0, 0, 0], scale(n, angle)));
    }
  }
  return new Map([...sums].map(([v, s]) => [v, normalize(s)]));
}

const MAX_REPORTED = 32;

function invalid(expected: string, detail: Record<string, unknown>): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail));
}

/**
 * Move vertices onto a target surface: each selected vertex goes
 * to its surface point plus `offset` along the surface normal; with a falloff, nearby
 * unselected vertices move by their weight. Topology never changes. Vertices without
 * a surface point within `maxDistance` stay and are reported as a warning; when no
 * vertex moves, `model-op-no-effect`.
 */
export function shrinkwrap(
  mesh: EditMesh,
  vertices: readonly number[],
  target: { readonly mesh: EditMesh; readonly faces: readonly number[] },
  options: ShrinkwrapOptions,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const mode = options.mode ?? 'nearest';
  if (mode !== 'nearest' && mode !== 'project') {
    return invalid("mode is 'nearest' or 'project'", { mode });
  }
  const offset = options.offset ?? 0;
  if (!Number.isFinite(offset)) return invalid('offset is a finite length', { offset });
  const maxDistance = options.maxDistance ?? Infinity;
  if (!(maxDistance > 0)) return invalid('maxDistance is a length > 0', { maxDistance });
  let direction: Tuple3 | 'normal' = 'normal';
  if (options.direction !== undefined) {
    if (mode !== 'project') {
      return invalid("direction applies to mode 'project'", { direction: options.direction });
    }
    if (options.direction !== 'normal') {
      const d = options.direction;
      if (!Array.isArray(d) || d.length !== 3 || !d.every(Number.isFinite) || length(d) === 0) {
        return invalid("direction is 'normal' or three finite numbers, not all zero", {
          direction: d,
        });
      }
      direction = normalize(d);
    }
  }
  let falloff: Required<Falloff> | undefined;
  if (options.falloff !== undefined) {
    const checked = checkFalloff(options.falloff);
    if (!checked.ok) return checked;
    falloff = checked.value;
  }
  const weights = falloffWeights(mesh, vertices, falloff);
  if (target.mesh === mesh) {
    const shared = target.faces.filter((f) => mesh.faceVertices(f).some((v) => weights.has(v)));
    if (shared.length > 0) {
      return invalid('the wrapped vertices (with their falloff) touch no target face', {
        faces: shared.slice(0, MAX_REPORTED),
        count: shared.length,
      });
    }
  }
  const surface = SurfaceQuery.of(target.mesh, target.faces);
  if (!surface.ok) return surface;
  const moving = [...weights.keys()].sort((a, b) => a - b);
  const normals =
    mode === 'project' && direction === 'normal' ? vertexNormals(mesh, new Set(moving)) : undefined;
  const placed = new Map<number, Tuple3>();
  const missed: number[] = [];
  let farthest = 0;
  for (const v of moving) {
    const p = mesh.position(v);
    let hit: SurfacePoint | undefined;
    if (mode === 'nearest') {
      hit = surface.value.below(p);
      if (hit !== undefined && hit.distance > maxDistance) hit = undefined;
    } else {
      const d = direction === 'normal' ? (normals?.get(v) ?? [0, 0, 0]) : direction;
      hit = length(d) === 0 ? undefined : surface.value.project(p, d, maxDistance);
    }
    if (hit === undefined) {
      missed.push(v);
      continue;
    }
    farthest = Math.max(farthest, hit.distance);
    const goal = add(hit.point, scale(hit.normal, offset));
    const w = weights.get(v) as number;
    placed.set(v, add(p, scale(sub(goal, p), w)));
  }
  if (missed.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `shrinkwrap found no surface point for ${missed.length} of ${moving.length} vertices`,
      detail: {
        missed: missed.length,
        vertices: missed.slice(0, MAX_REPORTED),
        at: missed.slice(0, MAX_REPORTED).map((v) => mesh.position(v)),
        ...(Number.isFinite(maxDistance) ? { maxDistance } : {}),
      },
    });
  }
  return applyDeformation(
    mesh,
    'shrinkwrap',
    moving,
    { kind: 'positions', position: (v) => placed.get(v) ?? mesh.position(v) },
    tolerance,
    diagnostics,
    () => ({
      mode,
      offset,
      wrapped: placed.size,
      missed: missed.length,
      farthestSurface: farthest,
      ...(falloff === undefined ? {} : { blended: moving.length - vertices.length }),
    }),
  );
}
