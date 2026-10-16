import type { GltfMeshIr } from './parse-gltf.js';

type VertexStream = Float32Array | Uint16Array;

const NORMAL_WELD_STEPS = 1024;

function faceNormal(positions: Float32Array, a: number, b: number, c: number, out: number[]): void {
  const ax = (positions[b * 3] ?? 0) - (positions[a * 3] ?? 0);
  const ay = (positions[b * 3 + 1] ?? 0) - (positions[a * 3 + 1] ?? 0);
  const az = (positions[b * 3 + 2] ?? 0) - (positions[a * 3 + 2] ?? 0);
  const bx = (positions[c * 3] ?? 0) - (positions[a * 3] ?? 0);
  const by = (positions[c * 3 + 1] ?? 0) - (positions[a * 3 + 1] ?? 0);
  const bz = (positions[c * 3 + 2] ?? 0) - (positions[a * 3 + 2] ?? 0);
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  if (len === 0 || !Number.isFinite(len)) {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return;
  }
  out[0] = nx / len;
  out[1] = ny / len;
  out[2] = nz / len;
}

function gather<T extends VertexStream>(stream: T, stride: number, sources: readonly number[]): T {
  const out = new (stream.constructor as new (length: number) => T)(sources.length * stride);
  for (let i = 0; i < sources.length; i++) {
    const src = (sources[i] ?? 0) * stride;
    out.set(stream.subarray(src, src + stride), i * stride);
  }
  return out;
}

/**
 * glTF 2.0 §3.7.2.1: a TRIANGLES primitive without NORMAL MUST use flat normals.
 * Indexed corners are split by face normal and re-welded when every attribute
 * matches (normals within 1/1024), so coplanar faces keep sharing vertices and
 * the primitive stays indexed.
 * Degenerate faces and trailing non-triangle vertices take the +Y fallback.
 */
export function withFlatNormals(mesh: GltfMeshIr): GltfMeshIr {
  const { indices, morphTargets, ...rest } = mesh;
  const positions = mesh.positions;
  const vertexCount = positions.length / 3;
  const normal = [0, 1, 0];
  if (indices === undefined) {
    const normals = new Float32Array(positions.length);
    for (let v = 0; v < vertexCount; v++) {
      if (v % 3 === 0) {
        if (v + 3 <= vertexCount) faceNormal(positions, v, v + 1, v + 2, normal);
        else normal.splice(0, 3, 0, 1, 0);
      }
      normals.set(normal, v * 3);
    }
    return { ...mesh, normals };
  }

  const streams: VertexStream[] = [];
  for (const [key, value] of Object.entries(rest))
    if (key !== 'morphWeights' && (value instanceof Float32Array || value instanceof Uint16Array))
      streams.push(value);
  for (const target of morphTargets ?? [])
    for (const value of [target.position, target.normal, target.tangent])
      if (value !== undefined) streams.push(value);

  const welded = new Map<string, number>();
  const sources: number[] = [];
  const normals: number[] = [];
  const remapped: number[] = new Array(indices.length);
  const parts: number[] = [];
  for (let corner = 0; corner < indices.length; corner++) {
    const face = corner - (corner % 3);
    if (corner === face) {
      if (face + 3 <= indices.length)
        faceNormal(
          positions,
          indices[face] ?? 0,
          indices[face + 1] ?? 0,
          indices[face + 2] ?? 0,
          normal,
        );
      else normal.splice(0, 3, 0, 1, 0);
    }
    const src = indices[corner] ?? 0;
    parts.length = 0;
    // Quantized so float noise between coplanar triangles does not split a face.
    for (const n of normal) parts.push(Math.round(n * NORMAL_WELD_STEPS));
    for (const stream of streams) {
      const stride = stream.length / vertexCount;
      for (let k = 0; k < stride; k++) parts.push(stream[src * stride + k] ?? 0);
    }
    const key = parts.join(',');
    let index = welded.get(key);
    if (index === undefined) {
      index = sources.length;
      welded.set(key, index);
      sources.push(src);
      normals.push(...normal);
    }
    remapped[corner] = index;
  }

  const expanded: Record<string, unknown> = { ...rest };
  for (const [key, value] of Object.entries(rest))
    if (key !== 'morphWeights' && (value instanceof Float32Array || value instanceof Uint16Array))
      expanded[key] = gather(value, value.length / vertexCount, sources);
  const expand = (stream: Float32Array) => gather(stream, stream.length / vertexCount, sources);
  return {
    ...(expanded as Omit<GltfMeshIr, 'indices' | 'morphTargets'>),
    positions: expanded.positions as Float32Array,
    normals: new Float32Array(normals),
    ...(morphTargets === undefined
      ? {}
      : {
          morphTargets: morphTargets.map((target) => ({
            ...(target.position === undefined ? {} : { position: expand(target.position) }),
            ...(target.normal === undefined ? {} : { normal: expand(target.normal) }),
            ...(target.tangent === undefined ? {} : { tangent: expand(target.tangent) }),
          })),
        }),
    indices: sources.length <= 0x10000 ? new Uint16Array(remapped) : new Uint32Array(remapped),
  };
}
