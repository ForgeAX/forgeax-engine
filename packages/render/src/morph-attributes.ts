import type { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { MESH_BIN_MORPH_CHANNELS } from '@forgeax/engine-pack/mesh-bin-contract';
import type { MeshAsset } from '@forgeax/engine-types';

export interface MorphChannel {
  readonly key: (typeof MESH_BIN_MORPH_CHANNELS)[number]['key'];
  readonly bit: number;
  readonly offset: number;
  readonly components: number;
}

export function morphChannels(
  mesh: Pick<MeshAsset, 'morphTargets'>,
  layout: ReturnType<typeof deriveVertexLayoutProjection>,
  vertexCount: number,
): readonly MorphChannel[] | undefined {
  const targets = mesh.morphTargets;
  if (targets === undefined || targets.length === 0) return undefined;
  const channels: MorphChannel[] = [];
  for (const channel of MESH_BIN_MORPH_CHANNELS) {
    if (!targets.some((target) => target[channel.key] !== undefined)) continue;
    const attribute = layout.attributes.find((attribute) => attribute.key === channel.key);
    const format = channel.components === 4 ? 'float32x4' : 'float32x3';
    if (attribute === undefined || attribute.format !== format) return undefined;
    if (
      targets.some(
        (target) =>
          target[channel.key] !== undefined &&
          target[channel.key]?.length !== vertexCount * channel.components,
      )
    )
      return undefined;
    channels.push({
      key: channel.key,
      bit: channel.mask,
      offset: attribute.offset / 4,
      components: channel.components,
    });
  }
  return channels.length === 0 ? undefined : channels;
}

/** Target-major, vertex-major, selected canonical channels. Missing deltas are zero. */
export function packMorphDeltas(
  mesh: MeshAsset,
  vertexCount: number,
  channels: readonly MorphChannel[],
): Float32Array {
  const targets = mesh.morphTargets ?? [];
  const stride = channels.reduce((size, channel) => size + channel.components, 0);
  const deltas = new Float32Array(targets.length * vertexCount * stride);
  for (const [targetIndex, target] of targets.entries())
    for (const [channelIndex, channel] of channels.entries()) {
      const source = target[channel.key];
      if (source === undefined) continue;
      for (let vertex = 0; vertex < vertexCount; vertex++)
        for (let lane = 0; lane < channel.components; lane++)
          deltas[(targetIndex * vertexCount + vertex) * stride + channelIndex * 3 + lane] = source[
            vertex * channel.components + lane
          ] as number;
    }
  return deltas;
}
