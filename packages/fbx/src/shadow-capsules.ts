import { fitShadowCapsules } from '@forgeax/engine-skinning';
import type { MeshAsset, SkeletonPod } from '@forgeax/engine-types';
import type { FbxRawDocument } from './parse-mesh';
import type { FbxRawSkinDoc } from './parse-skin';

/** Fit bind-space shadow capsules from the control-point influences the FBX importer publishes. */
export function deriveFbxShadowCapsules(
  skeleton: SkeletonPod,
  doc: FbxRawDocument & FbxRawSkinDoc,
): SkeletonPod {
  if (skeleton.shadowCapsules !== undefined) return skeleton;
  const meshes: Pick<MeshAsset, 'attributes'>[] = [];
  for (const skin of doc.skins ?? []) {
    const rawMesh = doc.meshes?.find((mesh) => mesh.sourceIndex === skin.meshSourceIndex);
    if (rawMesh === undefined) continue;
    const jointMap = skin.jointPaths.map((path) => skeleton.jointPaths.indexOf(path));
    if (jointMap.some((joint) => joint < 0)) continue;
    const skinIndex = new Uint16Array(skin.influences.length * 4);
    const skinWeight = new Float32Array(skin.influences.length * 4);
    skin.influences.forEach((influence, vertex) => {
      for (let lane = 0; lane < 4; lane++) {
        skinIndex[vertex * 4 + lane] = jointMap[influence.jointIndices[lane] ?? 0] ?? 0;
        skinWeight[vertex * 4 + lane] = influence.jointWeights[lane] ?? 0;
      }
    });
    meshes.push({
      attributes: { position: Float32Array.from(rawMesh.vertices), skinIndex, skinWeight },
    });
  }
  const shadowCapsules = fitShadowCapsules(meshes, skeleton.jointCount);
  return shadowCapsules === undefined ? skeleton : { ...skeleton, shadowCapsules };
}
