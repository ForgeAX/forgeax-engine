import {
  type AnimatedBoundsMesh,
  deriveConservativeAnimatedBounds,
} from '@forgeax/engine-animation/animated-bounds';
import { deriveAnimationTargetId } from '@forgeax/engine-animation/target-id';
import type { AnimationClipPod, SkeletonPod } from '@forgeax/engine-types';
import type { FbxRawDocument } from './parse-mesh';
import { buildFbxNodePaths, type FbxRawNodes } from './parse-scene';
import type { FbxRawSkinDoc } from './parse-skin';

/** Use the same resampled clips and control-point influences that the FBX importer publishes. */
export function deriveFbxAnimatedBounds(
  skeleton: SkeletonPod,
  doc: FbxRawDocument & FbxRawNodes & FbxRawSkinDoc,
  clips: readonly AnimationClipPod[],
): SkeletonPod {
  if (skeleton.bounds !== undefined) return skeleton;
  const rawNodes = doc.nodes ?? [];
  const paths = buildFbxNodePaths(rawNodes).map((path) =>
    path.ok ? path.value.join('/') : undefined,
  );
  const parents = new Map<number, number>();
  for (let index = 0; index < rawNodes.length; index++)
    for (const child of rawNodes[index]?.children ?? []) parents.set(child, index);
  const nodes = rawNodes.map((node, index) => ({
    ...node.transform,
    parent: parents.get(index) ?? null,
  }));
  const targetIds = paths.map((path) =>
    path === undefined ? undefined : deriveAnimationTargetId(path.split('/')),
  );
  const channels = clips.flatMap((clip) =>
    clip.channels.flatMap((channel) =>
      channel.property === 'weights'
        ? []
        : [
            {
              node: targetIds.indexOf(channel.targetId),
              property: channel.property,
              values: channel.sampler.output,
              interpolation: 'LINEAR' as const,
            },
          ],
    ),
  );
  const meshes: AnimatedBoundsMesh[] = [];
  for (const skin of doc.skins ?? []) {
    const rawMesh = doc.meshes?.find((mesh) => mesh.sourceIndex === skin.meshSourceIndex);
    if (rawMesh === undefined) return skeleton;
    const jointMap = skin.jointPaths.map((path) => skeleton.jointPaths.indexOf(path));
    if (jointMap.some((joint) => joint < 0)) return skeleton;
    const joints = skin.influences.flatMap((influence) =>
      [0, 1, 2, 3].map((lane) => jointMap[influence.jointIndices[lane] ?? 0] ?? -1),
    );
    const weights = skin.influences.flatMap((influence) =>
      [0, 1, 2, 3].map((lane) => influence.jointWeights[lane] ?? 0),
    );
    let maxMorphWeight = Math.max(0, ...(rawMesh.morphWeights ?? []).map(Math.abs));
    for (const clip of clips)
      for (const channel of clip.channels)
        if (channel.property === 'weights')
          for (const weight of channel.sampler.output)
            maxMorphWeight = Math.max(maxMorphWeight, Math.abs(weight));
    const morphExtent = Float32Array.from(
      rawMesh.vertices.map((_, index) =>
        (rawMesh.morphTargets ?? []).reduce(
          (sum, target) => sum + Math.abs(target.position?.[index] ?? 0) * maxMorphWeight,
          0,
        ),
      ),
    );
    let found = false;
    for (let index = 0; index < rawNodes.length; index++)
      if (rawNodes[index]?.meshIndex === skin.meshSourceIndex) {
        meshes.push({ node: index, positions: rawMesh.vertices, joints, weights, morphExtent });
        found = true;
      }
    if (!found) return skeleton;
  }
  const jointNodes = skeleton.jointPaths.map((path) => {
    const matches = rawNodes.flatMap((node, index) =>
      paths[index] === path || (!path.includes('/') && node.name === path) ? [index] : [],
    );
    return matches.length === 1 ? (matches[0] ?? -1) : -1;
  });
  if (jointNodes.some((node) => node < 0)) return skeleton;
  const bounds = deriveConservativeAnimatedBounds({
    nodes,
    channels,
    jointNodes,
    inverseBindMatrices: skeleton.inverseBindMatrices,
    meshes,
  });
  return bounds === undefined ? skeleton : { ...skeleton, bounds };
}
