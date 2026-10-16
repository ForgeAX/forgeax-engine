import type { Handle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { toMaterialAsset } from '../bridge.js';
import type { GltfMaterialIr } from '../parse-gltf.js';

describe('glTF material sampler mapping', () => {
  it('maps BLEND to straight-alpha state without depth writes', () => {
    const asset = toMaterialAsset({
      baseColorFactor: [1, 1, 1, 0.4],
      metallicFactor: 0,
      roughnessFactor: 1,
      alphaMode: 'BLEND',
    } as unknown as GltfMaterialIr);
    const state = asset.passes?.[0]?.renderState as {
      blend?: {
        color?: { srcFactor?: string; dstFactor?: string };
        alpha?: { srcFactor?: string; dstFactor?: string };
      };
      depthWriteEnabled?: boolean;
      queue?: number;
    };

    expect(state.queue).toBe(3000);
    expect(state.depthWriteEnabled).toBe(false);
    expect(state.blend).toMatchObject({
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    });
  });

  it('maps each texture slot to its own sampler GUID', () => {
    const asset = toMaterialAsset(
      {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 1,
        roughnessFactor: 1,
        baseColorTexture: { texture: 0, sampler: 10 },
        metallicRoughnessTexture: { texture: 1, sampler: 11 },
        normalTexture: { texture: 2, sampler: 12 },
        occlusionTexture: { texture: 3, sampler: 13 },
        emissiveTexture: { texture: 4, sampler: 14 },
      } as unknown as GltfMaterialIr,
      {
        textureHandles: new Map([
          [0, 100],
          [1, 101],
          [2, 102],
          [3, 103],
          [4, 104],
        ]) as unknown as ReadonlyMap<number, Handle<'TextureAsset', 'shared'>>,
        samplerHandles: new Map([
          [10, 200],
          [11, 201],
          [12, 202],
          [13, 203],
          [14, 204],
        ]) as unknown as ReadonlyMap<number, Handle<'SamplerAsset', 'shared'>>,
      },
    );
    const values = asset.values as Record<string, { sampler?: unknown }>;
    expect(values.baseColorTexture?.sampler).toBe(200);
    expect(values.metallicRoughnessTexture?.sampler).toBe(201);
    expect(values.normalTexture?.sampler).toBe(202);
    expect(values.occlusionTexture?.sampler).toBe(203);
    expect(values.emissiveTexture?.sampler).toBe(204);
  });
});
