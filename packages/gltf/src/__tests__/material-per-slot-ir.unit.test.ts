import { describe, expect, it } from 'vitest';
import { parseGltf } from '../parse-gltf.js';

const noopLoader = async (_uri: string) => new ArrayBuffer(0);

describe('glTF per-slot material IR', () => {
  it('keeps texture, sampler, coordinates, transform, and slot scalars independent', async () => {
    const result = await parseGltf(
      {
        asset: { version: '2.0' },
        textures: [
          { source: 0, sampler: 0 },
          { source: 1, sampler: 1 },
          { source: 2, sampler: 2 },
          { source: 3, sampler: 3 },
          { source: 4, sampler: 4 },
        ],
        materials: [
          {
            pbrMetallicRoughness: {
              baseColorTexture: {
                index: 0,
                texCoord: 1,
                extensions: {
                  KHR_texture_transform: {
                    offset: [0.1, 0.2],
                    rotation: 0.3,
                    scale: [1.1, 1.2],
                  },
                },
              },
              metallicRoughnessTexture: { index: 1, texCoord: 2 },
            },
            normalTexture: {
              index: 2,
              texCoord: 3,
              scale: 0.7,
              extensions: {
                KHR_texture_transform: {
                  offset: [0.4, 0.5],
                  rotation: 0.6,
                  scale: [1.4, 1.5],
                },
              },
            },
            occlusionTexture: { index: 3, texCoord: 4, strength: 0.8 },
            emissiveTexture: { index: 4, texCoord: 5 },
          },
        ],
      },
      noopLoader,
      '/per-slot.gltf',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const material = result.value.materials[0] as unknown as Record<string, unknown>;
    expect(material.baseColorTexture).toEqual({
      texture: 0,
      sampler: 0,
      texCoord: 1,
      transform: { offset: [0.1, 0.2], rotation: 0.3, scale: [1.1, 1.2] },
    });
    expect(material.metallicRoughnessTexture).toEqual({
      texture: 1,
      sampler: 1,
      texCoord: 2,
    });
    expect(material.normalTexture).toEqual({
      texture: 2,
      sampler: 2,
      texCoord: 3,
      transform: { offset: [0.4, 0.5], rotation: 0.6, scale: [1.4, 1.5] },
      scale: 0.7,
    });
    expect(material.occlusionTexture).toEqual({
      texture: 3,
      sampler: 3,
      texCoord: 4,
      strength: 0.8,
    });
    expect(material.emissiveTexture).toEqual({
      texture: 4,
      sampler: 4,
      texCoord: 5,
    });
    expect(material.coordinatesSet).toBeUndefined();
  });
});
