import type { GltfMeshIr } from './parse-gltf';

/** The primitive's original mesh index owns grouping, independent of flat row order. */
export function groupMeshPrimitives(
  meshes: readonly GltfMeshIr[],
): ReadonlyMap<number, readonly GltfMeshIr[]> {
  const groups = new Map<number, GltfMeshIr[]>();
  for (const mesh of meshes) {
    const group = groups.get(mesh.meshIndex);
    if (group === undefined) groups.set(mesh.meshIndex, [mesh]);
    else group.push(mesh);
  }
  return groups;
}
