import {
  AssetError,
  err,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { meshAttributeLayout, meshAttributeWindow } from './mesh-storage';
import { encodeTangentFrame32 } from './tangent-frame32';
import { deriveVertexLayoutProjection } from './vertex-attribute-layout';

/** Replace normal/tangent lanes with one canonical u32. Remaining attribute
 * bits, topology, bounds, material ranges and morph deltas are unchanged.
 * The result owns only packed rows; no decoded direction mirror is retained. */
export function packMeshTangentFrame32<T extends MeshAsset>(mesh: T): Result<T, AssetError> {
  if (mesh.attributes.tangentFrame !== undefined) return ok(mesh);
  const normal = meshAttributeWindow(mesh, 'normal'),
    tangent = meshAttributeWindow(mesh, 'tangent');
  const invalid = (actual: unknown) =>
    err(
      new AssetError({
        code: 'asset-invalid-value',
        expected: 'finite complete normal/tangent channels for a 32-bit orthonormal frame',
        hint: 'author a nonzero normal-plane tangent and orientation +/-1 before packing',
        detail: { field: 'tangentFrame', got: actual },
      }),
    );
  if (!normal || !tangent || normal.count !== tangent.count)
    return invalid('missing or mismatched direction channels');
  const attributes: VertexAttributeMap = { ...mesh.attributes, tangentFrame: new Uint32Array(0) };
  delete attributes.normal;
  delete attributes.tangent;
  const source = deriveVertexLayoutProjection(mesh.attributes),
    target = deriveVertexLayoutProjection(attributes);
  const count = normal.count,
    sourceStride = source.arrayStride / 4,
    targetStride = target.arrayStride / 4;
  if (!Number.isInteger(count) || mesh.vertices.byteLength !== count * source.arrayStride)
    return invalid('invalid packed cardinality');
  const vertices = new Float32Array(count * targetStride),
    words = new Uint32Array(vertices.buffer);
  const original = new Uint32Array(
    mesh.vertices.buffer,
    mesh.vertices.byteOffset,
    mesh.vertices.length,
  );
  const frame = target.attributes.find((entry) => entry.key === 'tangentFrame');
  if (!frame) return invalid('frame layout missing');
  // Resolve channel offsets once, then copy words without per-vertex slices.
  for (const entry of target.attributes) {
    if (entry.key === 'tangentFrame') continue;
    const from = source.attributes.find((value) => value.key === entry.key);
    if (!from || from.byteLength !== entry.byteLength) return invalid('source layout mismatch');
    for (let row = 0; row < count; row++)
      for (let lane = 0; lane < entry.byteLength / 4; lane++)
        words[row * targetStride + entry.offset / 4 + lane] = original[
          row * sourceStride + from.offset / 4 + lane
        ] as number;
  }
  try {
    for (let row = 0; row < count; row++) {
      const n = normal.offset + row * normal.stride,
        t = tangent.offset + row * tangent.stride;
      words[row * targetStride + frame.offset / 4] = encodeTangentFrame32(
        normal.data[n] as number,
        normal.data[n + 1] as number,
        normal.data[n + 2] as number,
        tangent.data[t] as number,
        tangent.data[t + 1] as number,
        tangent.data[t + 2] as number,
        tangent.data[t + 3] as number,
      );
    }
  } catch (cause) {
    return invalid(cause instanceof Error ? cause.message : String(cause));
  }
  return ok({
    ...mesh,
    vertices,
    attributeStorage: 'interleaved',
    attributes: meshAttributeLayout(attributes),
  });
}
