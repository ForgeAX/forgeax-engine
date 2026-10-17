import { fitShadowCapsules } from '@forgeax/engine-skinning';
import type { MeshAsset } from '@forgeax/engine-types';
import { groupMeshPrimitives } from './mesh-primitives';
import type { GltfDoc } from './parse-gltf';

/** Fit bind-space shadow capsules for every skin from all primitives drawn with it. */
export function deriveGltfShadowCapsules(doc: GltfDoc): GltfDoc {
  const primitivesByMesh = groupMeshPrimitives(doc.meshes);
  const skeletons = doc.skeletons.map((skeleton, skinIndex) => {
    if (skeleton.shadowCapsules !== undefined) return skeleton;
    const meshes: Pick<MeshAsset, 'attributes'>[] = [];
    for (const node of doc.nodes) {
      if (node.skinIndex !== skinIndex || node.meshIndex === null) continue;
      for (const mesh of primitivesByMesh.get(node.meshIndex) ?? []) {
        if (mesh.joints0 === undefined || mesh.weights0 === undefined) continue;
        meshes.push({
          attributes: {
            position: mesh.positions,
            skinIndex: mesh.joints0,
            skinWeight: mesh.weights0,
          },
        });
      }
    }
    const shadowCapsules = fitShadowCapsules(meshes, skeleton.jointCount);
    return shadowCapsules === undefined ? skeleton : { ...skeleton, shadowCapsules };
  });
  return { ...doc, skeletons };
}
