import { type Mat4Like, mat4, vec3 } from '@forgeax/engine-math';
import {
  ASSET_ERROR_HINTS,
  AssetError,
  err,
  type MeshAsset,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { meshFromInterleaved } from './box';

export interface DecalGeometryOptions {
  /** Maps the unit projection box [-0.5, 0.5] into the source mesh's local space. */
  readonly transform: Mat4Like;
  /** Minimum face-normal cosine against the projector's +Z axis, in [-1, 1]. */
  readonly normalThreshold?: number;
}

type Point = readonly [number, number, number];
interface Vertex {
  readonly position: Point;
  readonly normal: Point;
  readonly projected: Point;
}

function invalid(field: string, reason: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-parse-failed',
      expected: `valid decal geometry ${field}: ${reason}`,
      hint: ASSET_ERROR_HINTS['asset-parse-failed'],
      detail: { field, value: reason, reason },
    }),
  );
}

function attribute(raw: unknown): Float32Array | undefined {
  if (raw instanceof Float32Array) return raw;
  if (raw instanceof ArrayBuffer && raw.byteLength % 4 === 0) return new Float32Array(raw);
  return undefined;
}

function point(values: ArrayLike<number>, offset: number): Point {
  return [values[offset] as number, values[offset + 1] as number, values[offset + 2] as number];
}

function interpolate(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Sutherland-Hodgman clipping preserves both receiver positions and normals. */
function clip(vertices: readonly Vertex[], axis: number, sign: number): Vertex[] {
  const result: Vertex[] = [];
  let previous = vertices[vertices.length - 1];
  if (previous === undefined) return result;
  let previousDistance = sign * (previous.projected[axis] as number) - 0.5;
  for (const current of vertices) {
    const distance = sign * (current.projected[axis] as number) - 0.5;
    if (distance > 0 !== previousDistance > 0) {
      const t = previousDistance / (previousDistance - distance);
      result.push({
        position: interpolate(previous.position, current.position, t),
        normal: interpolate(previous.normal, current.normal, t),
        projected: interpolate(previous.projected, current.projected, t),
      });
    }
    if (distance <= 0) result.push(current);
    previous = current;
    previousDistance = distance;
  }
  return result;
}

/**
 * Pure local-space mesh projection, suitable for Pack generation or occasional
 * runtime placement. The result uses ordinary materials and follows the receiver
 * Transform. No intersecting, projectable triangles returns null. It does not bind skin/morph deformation or change receiver geometry.
 */
export function createDecalGeometry(
  source: MeshAsset,
  options: DecalGeometryOptions,
): Result<MeshAsset | null, AssetError> {
  const transform = options.transform;
  const threshold = options.normalThreshold ?? 0;
  if (
    transform.length !== 16 ||
    !Array.from(transform).every(Number.isFinite) ||
    transform[3] !== 0 ||
    transform[7] !== 0 ||
    transform[11] !== 0 ||
    transform[15] !== 1
  )
    return invalid('transform', 'expected a finite affine matrix');
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1)
    return invalid('normalThreshold', 'expected a finite cosine in [-1, 1]');
  const x = point(transform, 0);
  const y = point(transform, 4);
  const z = point(transform, 8);
  const cross = vec3.cross(vec3.create(), x, y);
  const determinant = vec3.dot(cross, z);
  const scale = Math.hypot(...x) * Math.hypot(...y) * Math.hypot(...z);
  if (scale === 0 || !Number.isFinite(scale) || Math.abs(determinant) <= scale * 1e-8)
    return invalid('transform', 'projection box must be invertible');
  const inverse = mat4.invert(mat4.create(), transform);
  if (
    !Array.from(inverse).every(Number.isFinite) ||
    !mat4.equals(
      mat4.multiply(mat4.create(), inverse, transform),
      mat4.identity(mat4.create()),
      1e-4,
    )
  )
    return invalid('transform', 'projection box must have a stable float32 inverse');
  const direction = vec3.normalize(vec3.create(), z);
  const positions = attribute(source.attributes?.position);
  const normals = attribute(source.attributes?.normal);
  if (positions === undefined || positions.length % 3 !== 0 || !positions.every(Number.isFinite))
    return invalid('attributes.position', 'expected finite float32 XYZ tuples');
  if (
    source.attributes?.normal !== undefined &&
    (normals === undefined ||
      normals.length !== positions.length ||
      !normals.every(Number.isFinite))
  )
    return invalid('attributes.normal', 'expected finite XYZ tuples matching positions');
  const indices = source.indices;
  if (
    indices !== undefined &&
    !(indices instanceof Uint16Array) &&
    !(indices instanceof Uint32Array)
  )
    return invalid('indices', 'expected Uint16Array or Uint32Array');
  const vertexCount = positions.length / 3;
  if (indices !== undefined && !indices.every((index) => index < vertexCount))
    return invalid('indices', 'index outside position array');
  if (source.submeshes.length === 0 || (indices === undefined && source.submeshes.length !== 1))
    return invalid('submeshes', 'expected indexed submeshes or one non-indexed submesh');
  for (const submesh of source.submeshes) {
    if (submesh.topology !== 'triangle-list') return invalid('topology', 'expected triangle-list');
    const count = indices === undefined ? submesh.vertexCount : submesh.indexCount;
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count % 3 !== 0 ||
      !Number.isInteger(submesh.indexOffset) ||
      submesh.indexOffset < 0 ||
      (indices === undefined
        ? submesh.indexOffset !== 0 || submesh.indexCount !== 0 || count !== vertexCount
        : submesh.indexOffset + count > indices.length)
    )
      return invalid('submeshes', 'invalid triangle range');
  }
  const output: number[] = [];
  const outputIndices: number[] = [];
  const projected = vec3.create();
  const ab = vec3.create();
  const ac = vec3.create();
  const faceNormal = vec3.create();
  for (const submesh of source.submeshes) {
    const count = indices === undefined ? submesh.vertexCount : submesh.indexCount;
    for (let offset = 0; offset < count; offset += 3) {
      const vertexIds = [0, 1, 2].map((corner) =>
        indices === undefined
          ? offset + corner
          : (indices[submesh.indexOffset + offset + corner] as number),
      );
      const p = vertexIds.map((index) => point(positions, index * 3));
      vec3.sub(ab, p[1] as Point, p[0] as Point);
      vec3.sub(ac, p[2] as Point, p[0] as Point);
      vec3.cross(faceNormal, ab, ac);
      if (Math.hypot(...faceNormal) === 0) continue;
      vec3.normalize(faceNormal, faceNormal);
      if (vec3.dot(faceNormal, direction) < threshold) continue;
      let polygon: Vertex[] = vertexIds.map((index, corner) => {
        const position = p[corner] as Point;
        mat4.transformVec3(projected, inverse, position);
        return {
          position,
          projected: point(projected, 0),
          normal: normals === undefined ? point(faceNormal, 0) : point(normals, index * 3),
        };
      });
      for (let axis = 0; axis < 3 && polygon.length >= 3; axis++) {
        polygon = clip(polygon, axis, 1);
        polygon = clip(polygon, axis, -1);
      }
      for (let corner = 1; corner + 1 < polygon.length; corner++) {
        const triangle = [polygon[0], polygon[corner], polygon[corner + 1]] as Vertex[];
        const [a, b, c] = triangle as [Vertex, Vertex, Vertex];
        if (
          Math.abs(
            (b.projected[0] - a.projected[0]) * (c.projected[1] - a.projected[1]) -
              (b.projected[1] - a.projected[1]) * (c.projected[0] - a.projected[0]),
          ) < 1e-12
        )
          continue;
        vec3.sub(ab, (triangle[1] as Vertex).position, (triangle[0] as Vertex).position);
        vec3.sub(ac, (triangle[2] as Vertex).position, (triangle[0] as Vertex).position);
        vec3.cross(projected, ab, ac);
        if (Math.hypot(...projected) === 0) continue;
        for (const vertex of triangle) {
          const length = Math.hypot(...vertex.normal);
          const normal = length > 0 ? vertex.normal.map((value) => value / length) : faceNormal;
          outputIndices.push(output.length / 8);
          output.push(
            ...vertex.position,
            ...normal,
            vertex.projected[0] + 0.5,
            0.5 - vertex.projected[1],
          );
        }
      }
    }
  }
  if (outputIndices.length === 0) return ok(null);
  return meshFromInterleaved(new Float32Array(output), new Uint32Array(outputIndices));
}
