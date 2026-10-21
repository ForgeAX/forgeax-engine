import type { MeshGpuHandles, MeshGpuRange } from '../device/gpu-residency';

/** Physical LOD ranges override author offsets for both indexed and non-indexed draws. */
export function submeshRange(mesh: MeshGpuHandles, index: number): MeshGpuRange {
  const physical = mesh.lodRanges?.[0]?.[index];
  if (physical !== undefined) return physical;
  const submesh = mesh.submeshes[index];
  if (submesh === undefined) throw new RangeError('Missing source submesh');
  if (mesh.indexed) return { first: submesh.indexOffset, count: submesh.indexCount, baseVertex: 0 };
  let first = 0;
  for (let preceding = 0; preceding < index; preceding++)
    first += mesh.submeshes[preceding]?.vertexCount ?? 0;
  return { first, count: submesh.vertexCount, baseVertex: 0 };
}
