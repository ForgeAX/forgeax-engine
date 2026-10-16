import {
  AssetError,
  err,
  type MeshAsset,
  type MeshCollision,
  ok,
  type Result,
} from '@forgeax/engine-types';

function failure(reason: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-parse-failed',
      expected: 'bounded static triangle geometry with finite positions and valid section ranges',
      hint: 'Repair the source mesh or meshCollision setting, then recook the same GUID.',
      detail: { field: 'collision', value: undefined, reason },
    }),
  );
}

/** Weld exact positions across material/UV seams; include only authored triangle coverage. */
export function buildMeshCollision(mesh: MeshAsset): Result<MeshCollision, AssetError> {
  const source = mesh.attributes?.position;
  if (
    !(source instanceof Float32Array) ||
    source.length < 9 ||
    source.length % 3 ||
    source.length > 3_145_728 ||
    (mesh.indices?.length ?? 0) > 3_145_728 ||
    mesh.morphTargets?.length ||
    mesh.attributes.skinIndex ||
    mesh.attributes.skinWeight
  )
    return failure(
      'collision cooking requires a static mesh with at most 1,048,576 vertices and triangles',
    );
  if (
    !Array.isArray(mesh.submeshes) ||
    !mesh.submeshes.length ||
    mesh.submeshes.some((section) => section.topology !== 'triangle-list')
  )
    return failure('collision sections must be triangle-list');
  const vertices: number[] = [],
    triangles: number[] = [];
  const welded = new Map<string, number>();
  const remap = new Map<number, number>();
  const vertex = (index: number): number => {
    const prior = remap.get(index);
    if (prior !== undefined) return prior;
    const x = Number(source[index * 3]),
      y = Number(source[index * 3 + 1]),
      z = Number(source[index * 3 + 2]);
    if (![x, y, z].every(Number.isFinite)) throw new TypeError('collision position is not finite');
    const key = `${x},${y},${z}`;
    let target = welded.get(key);
    if (target === undefined) {
      target = vertices.length / 3;
      welded.set(key, target);
      vertices.push(x, y, z);
    }
    remap.set(index, target);
    return target;
  };
  try {
    let nextVertex = 0,
      end = 0;
    for (const section of mesh.submeshes) {
      const offset = mesh.indices ? section.indexOffset : nextVertex;
      const count = mesh.indices ? section.indexCount : section.vertexCount;
      if (
        !Number.isInteger(offset) ||
        !Number.isInteger(count) ||
        offset < end ||
        count < 3 ||
        count % 3 ||
        offset + count > (mesh.indices?.length ?? source.length / 3) ||
        triangles.length + count > 3_145_728
      )
        return failure('invalid or overlapping triangle section range');
      for (let i = offset; i < offset + count; i += 3) {
        const a = mesh.indices?.[i] ?? i,
          b = mesh.indices?.[i + 1] ?? i + 1,
          c = mesh.indices?.[i + 2] ?? i + 2;
        if (
          ![a, b, c].every(
            (index) => Number.isInteger(index) && index >= 0 && index < source.length / 3,
          )
        )
          throw new TypeError('collision index is out of range');
        const ax = Number(source[a * 3]),
          ay = Number(source[a * 3 + 1]),
          az = Number(source[a * 3 + 2]);
        const abx = Number(source[b * 3]) - ax,
          aby = Number(source[b * 3 + 1]) - ay,
          abz = Number(source[b * 3 + 2]) - az;
        const acx = Number(source[c * 3]) - ax,
          acy = Number(source[c * 3 + 1]) - ay,
          acz = Number(source[c * 3 + 2]) - az;
        if (
          aby * acz - abz * acy === 0 &&
          abz * acx - abx * acz === 0 &&
          abx * acy - aby * acx === 0
        )
          continue;
        // Hull consumers use every point. Admit points only after triangle coverage survives.
        triangles.push(vertex(a), vertex(b), vertex(c));
      }
      end = offset + count;
      nextVertex = end;
    }
    if (!triangles.length) return failure('collision mesh has no nondegenerate triangles');
    return ok({ positions: new Float32Array(vertices), indices: new Uint32Array(triangles) });
  } catch (cause) {
    return failure(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Binary/JSON admission refuses stale products rather than silently rebuilding them. */
export function validateMeshCollisionAttachment(
  mesh: MeshAsset,
  value: unknown,
): Result<MeshCollision, AssetError> {
  if (!value || typeof value !== 'object') return failure('missing collision product');
  const raw = value as { positions?: unknown; indices?: unknown };
  const validPositions = raw.positions instanceof Float32Array || Array.isArray(raw.positions);
  const validIndices = raw.indices instanceof Uint32Array || Array.isArray(raw.indices);
  if (!validPositions || !validIndices)
    return failure('collision product requires position and index arrays');
  const positions = raw.positions as ArrayLike<number>,
    indices = raw.indices as ArrayLike<number>;
  if (positions.length > 3_145_728 || indices.length > 3_145_728)
    return failure('collision product exceeds geometry limits');
  const expected = buildMeshCollision(mesh);
  if (!expected.ok) return expected;
  if (
    positions.length !== expected.value.positions.length ||
    indices.length !== expected.value.indices.length
  )
    return failure('collision product does not match source geometry');
  for (let i = 0; i < positions.length; i++)
    if (positions[i] !== expected.value.positions[i])
      return failure('collision positions are stale or malformed');
  for (let i = 0; i < indices.length; i++)
    if (indices[i] !== expected.value.indices[i])
      return failure('collision triangles are stale or malformed');
  return expected;
}
