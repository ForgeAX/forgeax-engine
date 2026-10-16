import { describe, expect, it } from 'vitest';
import { materialRefsForPack } from '../gltf-importer.js';
import type { GltfDoc, GltfMaterialIr } from '../parse-gltf.js';

describe('glTF material Pack refs', () => {
  it('emits texture and sampler dependencies for every material slot', () => {
    const material = {
      name: 'PackMaterial',
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 1,
      roughnessFactor: 1,
      baseColorTexture: { texture: 0, sampler: 0 },
      metallicRoughnessTexture: { texture: 1, sampler: 1 },
      normalTexture: { texture: 2, sampler: 2 },
      occlusionTexture: { texture: 3, sampler: 3 },
      emissiveTexture: { texture: 4, sampler: 4 },
      transmissionTexture: { texture: 5, sampler: 5 },
      thicknessTexture: { texture: 6, sampler: 6 },
    } as unknown as GltfMaterialIr;
    const doc = {
      textures: [
        { source: 0, sampler: 0 },
        { source: 1, sampler: 1 },
        { source: 2, sampler: 2 },
        { source: 3, sampler: 3 },
        { source: 4, sampler: 4 },
        { source: 5, sampler: 5 },
        { source: 6, sampler: 6 },
      ],
    } as unknown as GltfDoc;
    const refs = materialRefsForPack(
      material,
      doc,
      new Map([
        [0, 'texture-0'],
        [1, 'texture-1'],
        [2, 'texture-2'],
        [3, 'texture-3'],
        [4, 'texture-4'],
        [5, 'texture-5'],
        [6, 'texture-6'],
      ]),
      new Map([
        [0, 'sampler-0'],
        [1, 'sampler-1'],
        [2, 'sampler-2'],
        [3, 'sampler-3'],
        [4, 'sampler-4'],
        [5, 'sampler-5'],
        [6, 'sampler-6'],
      ]),
    );
    expect(refs.map((ref) => ref.guid)).toEqual([
      'texture-0',
      'sampler-0',
      'texture-1',
      'sampler-1',
      'texture-2',
      'sampler-2',
      'texture-3',
      'sampler-3',
      'texture-4',
      'sampler-4',
      'texture-5',
      'sampler-5',
      'texture-6',
      'sampler-6',
    ]);
  });

  it('keeps the five physical extension texture edges in producer slot order', () => {
    const material = {
      name: 'PhysicalPackMaterial',
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 0.5,
      clearcoatNormalTexture: { texture: 0, sampler: 0 },
      anisotropyTexture: { texture: 1, sampler: 1 },
      sheenColorTexture: { texture: 2, sampler: 2 },
      iridescenceTexture: { texture: 3, sampler: 3 },
      specularColorTexture: { texture: 4, sampler: 4 },
    } as unknown as GltfMaterialIr;
    const doc = {
      textures: [
        { source: 0, sampler: 0 },
        { source: 1, sampler: 1 },
        { source: 2, sampler: 2 },
        { source: 3, sampler: 3 },
        { source: 4, sampler: 4 },
      ],
    } as unknown as GltfDoc;
    const refs = materialRefsForPack(
      material,
      doc,
      new Map([
        [0, 'clearcoat-normal-texture'],
        [1, 'anisotropy-texture'],
        [2, 'sheen-color-texture'],
        [3, 'iridescence-texture'],
        [4, 'specular-color-texture'],
      ]),
      new Map([
        [0, 'clearcoat-normal-sampler'],
        [1, 'anisotropy-sampler'],
        [2, 'sheen-color-sampler'],
        [3, 'iridescence-sampler'],
        [4, 'specular-color-sampler'],
      ]),
    );
    expect(refs.map((ref) => ref.guid)).toEqual([
      'clearcoat-normal-texture',
      'clearcoat-normal-sampler',
      'anisotropy-texture',
      'anisotropy-sampler',
      'sheen-color-texture',
      'sheen-color-sampler',
      'iridescence-texture',
      'iridescence-sampler',
      'specular-color-texture',
      'specular-color-sampler',
    ]);
  });
});
