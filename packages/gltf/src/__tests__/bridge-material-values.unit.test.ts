import type { AssetGuid, Handle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { toMaterialAsset } from '../bridge.js';
import type { GltfMaterialIr } from '../parse-gltf.js';

describe('glTF material bridge values', () => {
  it('publishes a parent-bearing child with only inherited contract and authored values', () => {
    const standardRootGuid = '01a065d4-47dd-789f-96b4-36b9326abc02' as unknown as AssetGuid;
    const material = toMaterialAsset(
      {
        baseColorFactor: [0.5, 0.75, 0.25, 1],
        metallicFactor: 0.5,
        roughnessFactor: 0.7,
      } as unknown as GltfMaterialIr,
      { standardRootGuid },
    );

    expect(material).toEqual({
      kind: 'material',
      parent: standardRootGuid,
      values: {
        baseColor: [0.5, 0.75, 0.25, 1],
        metallic: 0.5,
        roughness: 0.7,
      },
    });
    expect(Object.keys(material).sort()).toEqual(['kind', 'parent', 'values']);
  });

  it('preserves all four base-color channels for factor and texture composition', () => {
    const factor = [0.5, 0.75, 0.25, 0.4] as const;
    const material = toMaterialAsset({
      baseColorFactor: factor,
      metallicFactor: 0.5,
      roughnessFactor: 0.7,
      baseColorTexture: { texture: 0 },
    } as unknown as GltfMaterialIr);

    expect(material.values).toMatchObject({ baseColor: factor });
    expect(material.values).not.toHaveProperty('baseColorAlpha');
    expect(material.values).not.toHaveProperty('textureAlphaFactor');
  });

  it.each([
    ['default', undefined, 0.5],
    ['explicit', 0.73, 0.73],
    ['zero', 0, 0],
    ['one', 1, 1],
  ] as const)('projects MASK %s cutoff into the material contract', (_name, authored, expected) => {
    const material = toMaterialAsset({
      baseColorFactor: [1, 1, 1, 0.5],
      metallicFactor: 0,
      roughnessFactor: 1,
      alphaMode: 'MASK',
      ...(authored === undefined ? {} : { alphaCutoff: authored }),
    } as unknown as GltfMaterialIr);

    expect(material.values?.alphaCutoff).toBe(expected);
  });

  it('declares only authored texture slots in an imported Standard root', () => {
    const material = toMaterialAsset(
      {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 1,
        normalTexture: { texture: 0 },
      } as unknown as GltfMaterialIr,
      {
        textureHandles: new Map([[0, 100]]) as unknown as ReadonlyMap<
          number,
          Handle<'TextureAsset', 'shared'>
        >,
      },
    );
    expect(material.parameters?.filter((p) => p.type === 'texture').map((p) => p.name)).toEqual([
      'normalTexture',
    ]);
    expect(material.parameters?.find((p) => p.name === 'normalScale')?.default).toEqual([1, 1]);
    expect(material.parameters?.some((p) => p.name === 'directMultiscatteringLut')).toBe(false);
    expect(material.values?.normalTexture).toEqual({ texture: 100 });
  });

  it('projects five structured texture slots into standard-root values', () => {
    const material = toMaterialAsset(
      {
        baseColorFactor: [0.8, 0.2, 0.1, 1],
        metallicFactor: 0.5,
        roughnessFactor: 0.7,
        baseColorTexture: { texture: 0, sampler: 10, texCoord: 1 },
        metallicRoughnessTexture: { texture: 1, sampler: 11, texCoord: 2 },
        normalTexture: { texture: 2, sampler: 12, texCoord: 3, scale: 0.6 },
        occlusionTexture: { texture: 3, sampler: 13, texCoord: 4, strength: 0.8 },
        emissiveTexture: { texture: 4, sampler: 14, texCoord: 5 },
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

    expect(material.values?.normalTexture).not.toHaveProperty('normalScale');
    expect(material.passes?.[0]?.program.module).toBe('forgeax::default-standard-pbr');
    expect(material.colorSpace).toBe('linear');
    expect(material.values).toMatchObject({
      baseColor: [0.8, 0.2, 0.1, 1],
      metallic: 0.5,
      roughness: 0.7,
      baseColorTexture: { texture: 100, sampler: 200, coordinates: { set: 1 } },
      metallicRoughnessTexture: { texture: 101, sampler: 201, coordinates: { set: 2 } },
      normalTexture: { texture: 102, sampler: 202, coordinates: { set: 3 } },
      normalScale: [0.6, 0.6],
      occlusionTexture: {
        texture: 103,
        sampler: 203,
        coordinates: { set: 4 },
        occlusionStrength: 0.8,
      },
      emissiveTexture: { texture: 104, sampler: 204, coordinates: { set: 5 } },
    });
  });

  it('keeps identity texture authoring compact', () => {
    const material = toMaterialAsset(
      {
        baseColorTexture: { texture: 0 },
        metallicFactor: 0.5,
        roughnessFactor: 0.5,
      } as unknown as GltfMaterialIr,
      {
        textureHandles: new Map([[0, 100]]) as unknown as ReadonlyMap<
          number,
          Handle<'TextureAsset', 'shared'>
        >,
        samplerHandles: new Map(),
      },
    );

    expect(material.values?.baseColorTexture).toEqual({ texture: 100 });
    expect(material.values?.baseColorTexture).not.toHaveProperty('coordinates');
  });

  it('projects transmission and volume texture references without flattening coordinates', () => {
    const material = toMaterialAsset(
      {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 0.5,
        transmissionFactor: 0.8,
        transmissionTexture: { texture: 5, sampler: 15, texCoord: 2 },
        ior: 1.45,
        thicknessFactor: 0.2,
        thicknessTexture: {
          texture: 6,
          sampler: 16,
          texCoord: 3,
          transform: { offset: [0.1, 0.2] },
        },
        attenuationColor: [0.5, 0.6, 0.7],
        attenuationDistance: 2,
      } as unknown as GltfMaterialIr,
      {
        textureHandles: new Map([
          [5, 105],
          [6, 106],
        ]) as unknown as ReadonlyMap<number, Handle<'TextureAsset', 'shared'>>,
        samplerHandles: new Map([
          [15, 205],
          [16, 206],
        ]) as unknown as ReadonlyMap<number, Handle<'SamplerAsset', 'shared'>>,
      },
    );

    expect(material.values).toMatchObject({
      transmission: 0.8,
      ior: 1.45,
      thickness: 0.2,
      attenuationColor: [0.5, 0.6, 0.7],
      attenuationDistance: 2,
      transmissionTexture: { texture: 105, sampler: 205, coordinates: { set: 2 } },
      thicknessTexture: {
        texture: 106,
        sampler: 206,
        coordinates: { set: 3, transform: { offset: [0.1, 0.2] } },
      },
    });
  });

  it('owns a complete five-extension Standard root and admits only authored physical textures', () => {
    const material = toMaterialAsset(
      {
        name: 'physical-root',
        baseColorFactor: [0.8, 0.7, 0.6, 1],
        metallicFactor: 0.1,
        roughnessFactor: 0.35,
        clearcoatFactor: 0.75,
        clearcoatRoughnessFactor: 0.2,
        clearcoatNormalTexture: { texture: 0 },
        anisotropyStrength: 0.5,
        anisotropyRotation: 0.25,
        anisotropyTexture: { texture: 1 },
        sheenColorFactor: [0.2, 0.1, 0.05],
        sheenRoughnessFactor: 0.3,
        sheenColorTexture: { texture: 2 },
        iridescenceFactor: 0.6,
        iridescenceIor: 1.4,
        iridescenceThicknessMinimum: 120,
        iridescenceThicknessMaximum: 380,
        iridescenceTexture: { texture: 3 },
        specularFactor: 0.8,
        specularColorFactor: [0.9, 0.85, 0.75],
        specularColorTexture: { texture: 4 },
      } as unknown as GltfMaterialIr,
      {
        standardRootGuid: 'standard-root' as unknown as AssetGuid,
        textureHandles: new Map([
          [0, 100],
          [1, 101],
          [2, 102],
          [3, 103],
          [4, 104],
        ]) as unknown as ReadonlyMap<number, Handle<'TextureAsset', 'shared'>>,
      },
    );

    expect(material.parent).toBeUndefined();
    const names = new Set((material.parameters ?? []).map((parameter) => parameter.name));
    for (const name of [
      'clearcoat',
      'clearcoatRoughness',
      'clearcoatNormalTexture',
      'anisotropyStrength',
      'anisotropyRotation',
      'anisotropyTexture',
      'sheenColor',
      'sheenRoughness',
      'sheenColorTexture',
      'iridescence',
      'iridescenceIor',
      'iridescenceThicknessMinimum',
      'iridescenceThicknessMaximum',
      'iridescenceTexture',
      'specular',
      'specularColor',
      'specularColorTexture',
    ]) {
      expect(names.has(name)).toBe(true);
    }
    for (const name of [
      'clearcoatTexture',
      'clearcoatRoughnessTexture',
      'sheenRoughnessTexture',
      'iridescenceThicknessTexture',
      'specularTexture',
    ]) {
      expect(names.has(name)).toBe(false);
    }
    expect(material.values).toMatchObject({
      clearcoat: 0.75,
      anisotropyStrength: 0.5,
      sheenColor: [0.2, 0.1, 0.05],
      iridescenceIor: 1.4,
      specularColor: [0.9, 0.85, 0.75],
      clearcoatNormalTexture: { texture: 100 },
      anisotropyTexture: { texture: 101 },
      sheenColorTexture: { texture: 102 },
      iridescenceTexture: { texture: 103 },
      specularColorTexture: { texture: 104 },
    });
  });
});
