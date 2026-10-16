import { fitShadowCapsules } from '@forgeax/engine-skinning';
import type { MeshAsset } from '@forgeax/engine-types';
import type { GltfDoc } from './parse-gltf';

/** Fit bind-space shadow capsules for every skin from all primitives drawn with it. */
export function deriveGltfShadowCapsules(doc: GltfDoc): GltfDoc {
  const primitiveStarts: number[] = [];
  let offset = 0;
  for (const count of doc.meshPrimitiveCount?.values() ?? doc.meshes.map(() => 1)) {
    primitiveStarts.push(offset);
    offset += count;
  }
  const skeletons = doc.skeletons.map((skeleton, skinIndex) => {
    if (skeleton.shadowCapsules !== undefined) return skeleton;
    const meshes: Pick<MeshAsset, 'attributes'>[] = [];
    for (const node of doc.nodes) {
      if (node.skinIndex !== skinIndex || node.meshIndex === null) continue;
      const start = primitiveStarts[node.meshIndex];
      if (start === undefined) continue;
      const count = doc.meshPrimitiveCount?.get(node.meshIndex) ?? 1;
      for (const mesh of doc.meshes.slice(start, start + count)) {
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
