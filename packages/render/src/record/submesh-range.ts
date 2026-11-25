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
  if (mesh.indexed) range.first = submesh.indexOffset;
  else if (mesh.sectionFirstVertices !== undefined)
    range.first = mesh.sectionFirstVertices[index] as number;
  else {
    // Single-section resident meshes need no address column. Borrowed handles may
    // supply only the authored section counts.
    range.first = 0;
    for (let preceding = 0; preceding < index; preceding++)
      range.first += mesh.submeshes[preceding]?.vertexCount ?? 0;
  }
  return range;
}
