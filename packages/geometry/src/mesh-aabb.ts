import type { MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';

/**
 * Compute the local-space AABB of a mesh from its position attribute.
 *
 * Reads every third float from the position buffer as (x, y, z) and computes
 * [minX, minY, minZ, maxX, maxY, maxZ]. When position is absent, empty, or
 * less than 3 floats, returns an inverted-infinity empty box ([+Inf,+Inf,+Inf,
 * -Inf,-Inf,-Inf]) — consumers interpret this as "always-visible" (no culling).
 *
 * The position attribute can be Float32Array, ArrayBuffer (re-wrapped as
 * Float32Array), or Uint16Array (unlikely for position data; treated as
 * absent). Empty vertices (0 x 12 = 0) also produce empty box.
 *
 * Anchors: plan-strategy D-7 (register-time computation); D-1 (Float32Array
 * bare type); requirements AC-02 (empty -> inverted-infinity).
 */
function computeAABB(asset: TypesMeshAsset): Float32Array {
  const pos = asset.attributes.position;
  // Convert to Float32Array if possible; bail to empty-box otherwise.
  let floatPos: Float32Array;
  if (pos instanceof Float32Array) {
    floatPos = pos;
  } else if (pos instanceof ArrayBuffer) {
    floatPos = new Float32Array(pos);
  } else {
    return emptyBox();
  }
  if (floatPos.length < 3) return emptyBox();

  let minX = floatPos[0] ?? 0;
  let minY = floatPos[1] ?? 0;
  let minZ = floatPos[2] ?? 0;
  let maxX = minX;
  let maxY = minY;
  let maxZ = minZ;
  for (let i = 3; i < floatPos.length; i += 3) {
    const x = floatPos[i] ?? 0;
    const y = floatPos[i + 1] ?? 0;
    const z = floatPos[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return Float32Array.of(minX, minY, minZ, maxX, maxY, maxZ);
}

function emptyBox(): Float32Array {
  return Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
}

function hasPositionData(position: unknown): boolean {
  if (position instanceof Float32Array) return position.length >= 3;
  return (
    position instanceof ArrayBuffer && position.byteLength >= 3 * Float32Array.BYTES_PER_ELEMENT
  );
}

function isFiniteAabb(aabb: unknown): aabb is Float32Array {
  if (!(aabb instanceof Float32Array) || aabb.length !== 6) return false;
  for (const value of aabb) {
    if (!Number.isFinite(value)) return false;
  }
  const minX = aabb[0];
  const minY = aabb[1];
  const minZ = aabb[2];
  const maxX = aabb[3];
  const maxY = aabb[4];
  const maxZ = aabb[5];
  return (
    minX !== undefined &&
    minY !== undefined &&
    minZ !== undefined &&
    maxX !== undefined &&
    maxY !== undefined &&
    maxZ !== undefined &&
    minX <= maxX &&
    minY <= maxY &&
    minZ <= maxZ
  );
}

// Assigns the computed AABB to the mesh in place when the object is
// extensible; falls back to a shallow copy when frozen / sealed (e.g.
// BUILTIN_CUBE / BUILTIN_TRIANGLE / BUILTIN_QUAD reused via registerWithGuid).
export function withMeshAabb(asset: TypesMeshAsset): TypesMeshAsset {
  // Packed mesh binaries intentionally omit `attributes.position`; their
  // producer-computed AABB is the only available culling fact. Preserve it
  // instead of replacing it with the empty-box result from computeAABB().
  if (!hasPositionData(asset.attributes.position) && isFiniteAabb(asset.aabb)) {
    return asset;
  }
  const aabb = computeAABB(asset);
  // The producer envelope may include shader deformation beyond position data.
  if (isFiniteAabb(asset.aabb) && isFiniteAabb(aabb)) {
    for (let axis = 0; axis < 3; axis += 1) {
      aabb[axis] = Math.min(aabb[axis] ?? Infinity, asset.aabb[axis] ?? Infinity);
      aabb[axis + 3] = Math.max(aabb[axis + 3] ?? -Infinity, asset.aabb[axis + 3] ?? -Infinity);
    }
  }
  if (Object.isExtensible(asset)) {
    (asset as { aabb: Float32Array }).aabb = aabb;
    return asset;
  }
  return { ...asset, aabb };
}
