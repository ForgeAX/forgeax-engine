import { describe, expect, it } from 'vitest';
import { validateMaterialUvSets } from '../bridge.js';
import type { GltfMaterialIr } from '../parse-gltf.js';

describe('glTF material UV validation', () => {
  it('returns structured failure without a material product when a requested set is absent', () => {
    const result = validateMaterialUvSets(
      {
        name: 'MissingUvMaterial',
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 1,
        roughnessFactor: 1,
        baseColorTexture: { texture: 0, texCoord: 2 },
      } as unknown as GltfMaterialIr,
      'primitive-3',
      [0, 1],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('gltf-material-uv-set-missing');
    expect(result.error.detail).toEqual({
      material: 'MissingUvMaterial',
      primitive: 'primitive-3',
      slot: 'baseColorTexture',
      requestedSet: 2,
      availableSets: [0, 1],
    });
  });
});
