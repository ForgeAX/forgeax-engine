import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  linearChannelToSrgb,
  type MeshAsset,
  sha256Bytes,
  srgbChannelToLinear,
  type TextureAsset,
} from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import checkerPack, {
  CHECKER_LINEAR,
  CHECKER_SIZE,
  checkerLinearLevels,
  checkerTextureBytes,
} from '../../assets/checker.pack.ts';
import materialsPack from '../../assets/materials.pack.ts';
import meshesPack from '../../assets/meshes.pack.ts';
import impulseNoisePack from '../../assets/water/impulse-noise.pack.ts';
import waterMaterialsPack from '../../assets/water/materials.pack.ts';
import surfaceTexturesPack from '../../assets/water/surface-textures.pack.ts';
import volumeNoisePack from '../../assets/water/volume-noise.pack.ts';
import { CONTENT_MESH_NAMES, type ContentWaterTextureName, EngineContent } from '../index';

import { impulseNoiseReference } from './impulse-noise-reference';

const WATER_SURFACE_TEXTURES = [
  ['normal', 'f030e1fd-5b3c-57a1-a60c-018ceef83acd', 1024, 'linear'],
  ['river-diffuse', 'f9c181e7-9b0a-5297-9799-f2bc20b5f43a', 512, 'srgb'],
  ['river-normal', '7b9c681f-731b-5180-9de3-d01351fffb49', 512, 'linear'],
  ['foam', '19dbdb35-7706-50d8-97c4-b60fdf45bff5', 2048, 'srgb'],
  ['foam-normal', '987bf773-9f95-55ad-b4f4-cd6c9f0f4498', 2048, 'linear'],
  ['noise', '1f8cd962-b062-5604-94b1-9b7e2137720c', 64, 'linear'],
] as const satisfies readonly (readonly [
  ContentWaterTextureName,
  string,
  number,
  TextureAsset['colorSpace'],
])[];

async function outputs(pack: {
  readonly packageId: Uint8Array;
  readonly build: (context: never) => unknown;
}): Promise<Map<string, Record<string, unknown>>> {
  const result = (await pack.build(undefined as never)) as {
    readonly ok: boolean;
    readonly value: Record<string, Record<string, unknown>>;
  };
  expect(result.ok).toBe(true);
  return new Map(
    Object.entries(result.value).map(([key, value]) => [
      AssetGuid.format(AssetGuid.derive(pack.packageId as never, key)),
      value,
    ]),
  );
}

function floats(value: unknown): Float32Array {
  expect(value).toBeInstanceOf(Float32Array);
  return value as Float32Array;
}

describe('Engine Content', () => {
  let textureOutputs: Map<string, Record<string, unknown>>;
  beforeAll(async () => {
    textureOutputs = await outputs(checkerPack);
    for (const pack of [surfaceTexturesPack, impulseNoisePack, volumeNoisePack])
      for (const [guid, asset] of await outputs(pack)) textureOutputs.set(guid, asset);
  });

  it('keeps checker independent and publishes Water surfaces as byte-free GPU textures', async () => {
    expect([...(await outputs(checkerPack)).keys()].sort()).toEqual(
      [EngineContent.textures.checker, EngineContent.samplers.checker].sort(),
    );
    for (const [name, guid, size, colorSpace] of WATER_SURFACE_TEXTURES) {
      expect(EngineContent.water.textures[name]).toBe(guid);
      const texture = textureOutputs.get(guid);
      const source = texture?.source as { generator: string };
      expect(texture, name).toEqual({
        kind: 'gpu-texture',
        shape: { viewDimension: '2d', extent: { width: size, height: size } },
        format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
        colorSpace,
        mips: { kind: 'generate' },
        source: { kind: 'generated', generator: expect.any(String), output: name },
      });
      const generator = textureOutputs.get(source.generator);
      expect(generator, name).toMatchObject({
        kind: 'texture-generator',
        outputs: { [name]: { shape: texture?.shape, mips: { kind: 'generate' } } },
      });
    }
  });

  it('publishes the Water volume at its stable GUID as a byte-free, single-channel GPU texture', () => {
    const guid = '8cfb3537-cbc8-5195-bc8c-c03f2513508f';
    expect(EngineContent.water.textures['volume-noise']).toBe(guid);
    const texture = textureOutputs.get(guid);
    expect(texture).toEqual({
      kind: 'gpu-texture',
      shape: { viewDimension: '3d', extent: { width: 128, height: 128, depth: 128 } },
      format: 'r8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      source: { kind: 'generated', generator: expect.any(String), output: 'noise' },
    });
    const source = texture?.source as { generator: string };
    expect(textureOutputs.get(source.generator)).toMatchObject({
      kind: 'texture-generator',
      passes: [{ kind: 'compute-volume', writes: ['noise'] }],
    });
  });

  it('publishes nine custom GPU impulse-noise mips at the stable GUID', () => {
    const guid = EngineContent.water.textures['impulse-noise'];
    expect(guid).toBe('12734661-7b8e-5bb1-8ab4-8cad728c536f');
    const texture = textureOutputs.get(guid);
    expect(texture).toMatchObject({
      kind: 'gpu-texture',
      format: 'rgba8unorm-srgb',
      colorSpace: 'srgb',
      mips: { kind: 'custom', levelCount: 9 },
    });
    expect(texture).not.toHaveProperty('data');
    const reference = impulseNoiseReference();
    expect(reference.byteLength).toBe(349524);
    expect(sha256Bytes(reference)).toBe(
      'c07e949104fbd663c9d478519a9abaff15dca0b3d50049c1e0b1be87f2ebc928',
    );
  });

  it('publishes exactly the EngineContent GUID set from its Pack sources', async () => {
    const built = new Set(
      [...textureOutputs]
        .filter(([, value]) => value.kind !== 'texture-generator')
        .map(([guid]) => guid),
    );
    for (const pack of [meshesPack, materialsPack, waterMaterialsPack])
      for (const guid of (await outputs(pack)).keys()) built.add(guid);
    const declared = [
      ...Object.values(EngineContent.meshes),
      ...Object.values(EngineContent.textures),
      ...Object.values(EngineContent.samplers),
      ...Object.values(EngineContent.materials),
      ...Object.values(EngineContent.water.textures),
      ...Object.values(EngineContent.water.materials),
      EngineContent.water.sampler,
    ];
    expect(new Set(declared).size).toBe(declared.length);
    expect([...built].sort()).toEqual([...declared].sort());
  });

  it('gives every mesh complete vertex attributes and the default checker material', async () => {
    const meshes = await outputs(meshesPack);
    for (const name of CONTENT_MESH_NAMES) {
      const mesh = meshes.get(EngineContent.meshes[name]) as unknown as MeshAsset;
      expect(mesh.kind, name).toBe('mesh');
      const vertexCount = floats(mesh.attributes.position).length / 3;
      expect(vertexCount, name).toBeGreaterThan(2);
      expect(floats(mesh.attributes.normal).length, name).toBe(vertexCount * 3);
      expect(floats(mesh.attributes.tangent).length, name).toBe(vertexCount * 4);
      expect(floats(mesh.attributes.uv).length, name).toBe(vertexCount * 2);
      const color = floats(mesh.attributes.color);
      expect(color.length, name).toBe(vertexCount * 4);
      expect(
        color.every((component) => component === 1),
        name,
      ).toBe(true);
      expect(mesh.vertices.length, name).toBe(vertexCount * (3 + 3 + 2 + 4 + 4));
      const slots = mesh.materialSlots ?? [];
      expect(slots, name).toHaveLength(1);
      expect(AssetGuid.format(slots[0]?.defaultMaterial as never), name).toBe(
        EngineContent.materials.default,
      );
      const aabb = mesh.aabb as Float32Array;
      for (let axis = 0; axis < 3; axis++) {
        expect(aabb[axis], name).toBeGreaterThanOrEqual(-0.5 - 1e-6);
        expect(aabb[axis + 3], name).toBeLessThanOrEqual(0.5 + 1e-6);
      }
    }
    const plane = meshes.get(EngineContent.meshes.plane) as unknown as MeshAsset;
    expect(Array.from(floats(plane.attributes.normal).subarray(0, 3))).toEqual([0, 1, 0]);
    expect(Array.from((plane.aabb as Float32Array).subarray(0, 6))).toEqual([
      -0.5, 0, -0.5, 0.5, 0, 0.5,
    ]);
  });

  it('box-filters the checker mip chain in linear space down to one mean gray texel', () => {
    const levels = checkerLinearLevels();
    expect(levels).toHaveLength(Math.log2(CHECKER_SIZE) + 1);
    const mean = (level: Float32Array) =>
      level.reduce((sum, value) => sum + value, 0) / level.length;
    const expected = (CHECKER_LINEAR[0] + CHECKER_LINEAR[1]) / 2;
    for (const level of levels) expect(mean(level)).toBeCloseTo(expected, 6);
    expect(levels.at(-1)).toHaveLength(1);

    const bytes = checkerTextureBytes();
    let offset = 0;
    const decodedMeans: number[] = [];
    let nonGrayOpaqueTexels = 0;
    for (const level of levels) {
      let sum = 0;
      for (let texel = 0; texel < level.length; texel++, offset += 4) {
        const r = bytes[offset] ?? 0;
        if (r !== bytes[offset + 1] || r !== bytes[offset + 2] || bytes[offset + 3] !== 255)
          nonGrayOpaqueTexels++;
        sum += srgbChannelToLinear(r / 255);
      }
      decodedMeans.push(sum / level.length);
    }
    expect(nonGrayOpaqueTexels).toBe(0);
    expect(offset).toBe(bytes.length);
    const [base = Number.NaN] = decodedMeans;
    for (const value of decodedMeans) expect(Math.abs(value - base)).toBeLessThan(0.004);
    const last = bytes.subarray(bytes.length - 4);
    expect(last[0]).toBe(Math.round(linearChannelToSrgb(expected) * 255));
  });

  it('round-trips the sRGB transfer function', () => {
    for (let index = 0; index <= 32; index++) {
      const value = index / 32;
      expect(srgbChannelToLinear(linearChannelToSrgb(value))).toBeCloseTo(value, 6);
    }
  });

  it('declares the checker as a mipmapped sRGB texture with a 16x anisotropic repeat sampler', async () => {
    const built = textureOutputs;
    const texture = built.get(EngineContent.textures.checker) as unknown as TextureAsset;
    expect(texture).toMatchObject({
      format: 'rgba8unorm-srgb',
      colorSpace: 'srgb',
      mips: { kind: 'packed', levelCount: 9 },
    });
    expect(built.get(EngineContent.samplers.checker)).toEqual({
      kind: 'sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 16,
    });
    const material = (await outputs(materialsPack)).get(EngineContent.materials.default);
    expect(JSON.stringify(material)).toContain('baseColorTexture');
  });
});
