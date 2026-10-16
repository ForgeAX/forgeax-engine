import {
  type AnimatedBoundsMesh,
  cubicValueEnvelope,
  deriveConservativeAnimatedBounds,
} from '@forgeax/engine-animation/animated-bounds';
import { buildNodeParentMap, resolveNamedNodePath } from './node-path';
import type { GltfDoc } from './parse-gltf';

/** Source extras and sidecar bounds have already been applied before this producer runs. */
export function deriveGltfAnimatedBounds(doc: GltfDoc): GltfDoc {
  const parents = buildNodeParentMap(doc.nodes);
  const paths = doc.nodes.map((_, index) => {
    const path = resolveNamedNodePath(doc.nodes, parents, index);
    return path.ok ? path.value.join('/') : undefined;
  });
  const nodes = doc.nodes.map((node, index) => ({
    ...node.transform,
    parent: parents.get(index) ?? null,
  }));
  const channels = doc.animationClips.flatMap((clip) =>
    clip.channels.flatMap((channel) =>
      channel.property === 'weights'
        ? []
        : [
            {
              node: channel.targetNodeIndex,
              property: channel.property,
              values:
                channel.sampler.interpolation === 'CUBICSPLINE'
                  ? cubicValueEnvelope(
                      channel.sampler.input,
                      channel.sampler.output,
                      channel.property === 'rotation' ? 4 : 3,
                    )
                  : channel.sampler.output,
              interpolation: 'LINEAR' as const,
            },
          ],
    ),
  );
  const primitiveStarts: number[] = [];
  let offset = 0;
  for (const count of doc.meshPrimitiveCount?.values() ?? doc.meshes.map(() => 1)) {
    primitiveStarts.push(offset);
    offset += count;
  }
  const skeletons = doc.skeletons.map((skeleton, skinIndex) => {
    if (skeleton.bounds !== undefined) return skeleton;
    const meshes: AnimatedBoundsMesh[] = [];
    for (let index = 0; index < doc.nodes.length; index++) {
      const node = doc.nodes[index];
      if (node === undefined) return skeleton;
      if (node.skinIndex !== skinIndex || node.meshIndex === null) continue;
      const start = primitiveStarts[node.meshIndex];
      if (start === undefined) return skeleton;
      for (const mesh of doc.meshes.slice(
        start,
        start + (doc.meshPrimitiveCount?.get(node.meshIndex) ?? 1),
      )) {
        if (mesh.joints0 === undefined || mesh.weights0 === undefined) return skeleton;
        let maxMorphWeight = Math.max(
          0,
          ...Array.from(node.morphWeights ?? mesh.morphWeights ?? [], Math.abs),
        );
        for (const clip of doc.animationClips)
          for (const channel of clip.channels)
            if (channel.targetNodeIndex === index && channel.property === 'weights')
              for (const weight of channel.sampler.interpolation === 'CUBICSPLINE'
                ? cubicValueEnvelope(
                    channel.sampler.input,
                    channel.sampler.output,
                    channel.sampler.output.length / channel.sampler.input.length / 3,
                  )
                : channel.sampler.output)
                maxMorphWeight = Math.max(maxMorphWeight, Math.abs(weight));
        const morphExtent = Float32Array.from(mesh.positions, (_, component) =>
          (mesh.morphTargets ?? []).reduce(
            (sum, target) => sum + Math.abs(target.position?.[component] ?? 0) * maxMorphWeight,
            0,
          ),
        );
        meshes.push({
          node: index,
          positions: mesh.positions,
          joints: mesh.joints0,
          weights: mesh.weights0,
          morphExtent,
        });
      }
    }
    const jointNodes = skeleton.jointPaths.map((path) => paths.indexOf(path));
    if (
      jointNodes.some(
        (node, index) => node < 0 || paths.lastIndexOf(skeleton.jointPaths[index]) !== node,
      )
    )
      return skeleton;
    const bounds = deriveConservativeAnimatedBounds({
      nodes,
      channels,
      jointNodes,
      inverseBindMatrices: skeleton.inverseBindMatrices,
      meshes,
    });
    return bounds === undefined ? skeleton : { ...skeleton, bounds };
  });
  return { ...doc, skeletons };
}
