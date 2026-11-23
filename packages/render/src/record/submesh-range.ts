import type { MeshGpuHandles, MeshGpuRange } from '../device/gpu-residency';

/** Physical LOD ranges override author offsets for both indexed and non-indexed draws. */
export function submeshRange(
  mesh: MeshGpuHandles,
  index: number,
  target?: { first: number; count: number; baseVertex: number },
): MeshGpuRange {
  const physical = mesh.lodRanges?.[0]?.[index];
  if (physical !== undefined) return physical;
  const submesh = mesh.submeshes[index];
  if (submesh === undefined) throw new RangeError('Missing source submesh');
  const range = target ?? { first: 0, count: 0, baseVertex: 0 };
  range.baseVertex = 0;
  range.count = mesh.indexed ? submesh.indexCount : submesh.vertexCount;
  range.first = mesh.indexed ? submesh.indexOffset : 0;
  if (!mesh.indexed)
    for (let preceding = 0; preceding < index; preceding++)
      range.first += mesh.submeshes[preceding]?.vertexCount ?? 0;
  return range;
}
