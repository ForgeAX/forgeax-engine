import { mat4, type vec3 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';

/** Private primitive traversal. Callers select supported topologies and own hit policy. */
export function visitSubmeshTriangles(
  submesh: MeshAsset['submeshes'][number],
  indices: MeshAsset['indices'],
  firstTriangle: number,
  visit: (i0: number, i1: number, i2: number, triangleIndex: number) => void,
): number {
  const strip = submesh.topology === 'triangle-strip';
  const indexed = indices !== undefined && indices.length > 0 && submesh.indexCount > 0;
  const size = indexed ? submesh.indexCount : submesh.vertexCount;
  const count = strip ? Math.max(0, size - 2) : Math.floor(size / 3);
  for (let triangle = 0; triangle < count; triangle++) {
    const base = (indexed ? submesh.indexOffset : 0) + triangle * (strip ? 1 : 3);
    const i0 = indexed ? (indices[base] as number) : base;
    const i1 = indexed ? (indices[base + 1] as number) : base + 1;
    const i2 = indexed ? (indices[base + 2] as number) : base + 2;
    // Keep WebGPU strip winding so the caller's barycentrics name authored vertices.
    if (strip && (triangle & 1) !== 0) visit(i2, i1, i0, firstTriangle + triangle);
    else visit(i0, i1, i2, firstTriangle + triangle);
  }
  return firstTriangle + count;
}

/** Transform one packed XYZ vertex in the caller's query-local scratch. */
export function transformMeshVertex(
  out: vec3.Vec3,
  positions: Float32Array,
  index: number,
  matrix: mat4.Mat4Like,
): void {
  out[0] = positions[index * 3] as number;
  out[1] = positions[index * 3 + 1] as number;
  out[2] = positions[index * 3 + 2] as number;
  mat4.transformPoint(out, matrix, out);
}
