import { prepareRuntimeTexture } from '@forgeax/engine-image';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type MeshAsset, sha256Bytes, type TextureAsset } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import checkerPack, {
  CHECKER_LINEAR,
  CHECKER_SIZE,
  checkerLinearLevels,
  checkerTextureBytes,
  linearToSrgb,
  srgbToLinear,
} from '../../assets/checker.pack.ts';
import materialsPack from '../../assets/materials.pack.ts';
import meshesPack from '../../assets/meshes.pack.ts';
import impulseNoisePack from '../../assets/water/impulse-noise.pack.ts';
import waterMaterialsPack from '../../assets/water/materials.pack.ts';
import volumeNoisePack from '../../assets/water/volume-noise.pack.ts';
import {
  CONTENT_MESH_NAMES,
  CONTENT_WATER_TEXTURE_NAMES,
  type ContentWaterTextureName,
  EngineContent,
} from '../index';

interface TextureBaseline {
  readonly guid: string;
  readonly sha256: string;
  readonly size: number;
  readonly colorSpace: TextureAsset['colorSpace'];
  readonly dimension: '2d' | '3d';
  readonly mips: TextureAsset['mips'];
}

const WATER_TEXTURE_BASELINES: Readonly<Record<ContentWaterTextureName, TextureBaseline>> = {
  normal: {
    guid: '0c855c2a-7f29-5e28-b30f-c8669de0202e',
    size: 1024,
    colorSpace: 'linear',
    dimension: '2d',
    mips: { kind: 'generate' },
    sha256: 'a7a028cb06b3bb9fafba4ea8fca669621e9b764b75f436222ac04897c1707c90',
  },
  'river-diffuse': {
    guid: 'ef7f4ae3-f033-5d51-b756-18c8d4a6b40c',
    size: 512,
    colorSpace: 'srgb',
    dimension: '2d',
    mips: { kind: 'generate' },
    sha256: '76ff99629b6273ee9f24b76c4d93fd3892c4a456ac95376e29402c01e5506996',
  },
  'river-normal': {
    guid: 'b8287107-941e-5335-a055-34d704d458dd',
    size: 512,
    colorSpace: 'linear',
    dimension: '2d',
    mips: { kind: 'generate' },
    sha256: 'dd9ed02b24f091e45f8a62c234815fd363ffb26aa4f0cf43ac187c69fac804ff',
  },
  foam: {
    guid: '74a9fd75-4f63-5abd-bcc8-7ac02f2a1295',
    size: 2048,
    colorSpace: 'srgb',
    dimension: '2d',
    mips: { kind: 'generate' },
    sha256: '3438f779eb5a202917fd2877c3acdcdc9c9072cde16495eb30e8ff233f7a0f35',
  },
  'foam-normal': {
    guid: '30824247-9646-53fa-909f-77385db8e5cc',
    size: 2048,
    colorSpace: 'linear',
    dimension: '2d',
    mips: { kind: 'generate' },
    sha256: '707dbb6bf8859a571a2fba9aa4ba683a1e197ab170a55c3d4ea54fe799c48aab',
  },
  noise: {
    guid: 'ffe75b88-edb3-5dba-882f-4aa8d17aba3a',
    size: 64,
    colorSpace: 'linear',
    dimension: '2d',
    mips: { kind: 'generate' },
    sha256: '2b385c873b217e368731dfea62cb843f8758d912ccff1325e9ab18c7c839cb70',
  },
  'impulse-noise': {
    guid: '12734661-7b8e-5bb1-8ab4-8cad728c536f',
    size: 256,
    colorSpace: 'srgb',
    dimension: '2d',
    mips: { kind: 'packed', levelCount: 9 },
    sha256: 'c07e949104fbd663c9d478519a9abaff15dca0b3d50049c1e0b1be87f2ebc928',
  },
  'volume-noise': {
    guid: '8cfb3537-cbc8-5195-bc8c-c03f2513508f',
    size: 128,
    colorSpace: 'linear',
    dimension: '3d',
    mips: { kind: 'none' },
    sha256: '7796f733c2ad110e4f274c3faada7408f43019363b733689478be46d36c1209d',
  },
};

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
    for (const pack of [impulseNoisePack, volumeNoisePack])
      for (const [guid, asset] of await outputs(pack)) textureOutputs.set(guid, asset);
  });

  it('publishes every Water texture with stable pixels, GUIDs and native mip contracts', () => {
    for (const name of CONTENT_WATER_TEXTURE_NAMES) {
      const baseline = WATER_TEXTURE_BASELINES[name];
      expect(EngineContent.water.textures[name], name).toBe(baseline.guid);
      const texture = textureOutputs.get(baseline.guid) as unknown as TextureAsset;
      expect(texture.kind, name).toBe('texture');
      expect(texture.shape, name).toEqual({
        viewDimension: baseline.dimension,
        extent: {
          width: baseline.size,
          height: baseline.size,
          ...(baseline.dimension === '3d' ? { depth: baseline.size } : {}),
        },
      });
      expect(texture.colorSpace, name).toBe(baseline.colorSpace);
      expect(texture.format, name).toBe(
        baseline.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
      );
      expect(texture.mips, name).toEqual(baseline.mips);
      expect(sha256Bytes(texture.data), name).toBe(baseline.sha256);
      expect(prepareRuntimeTexture(texture).ok, name).toBe(true);
      if (name === 'river-normal' || name === 'foam-normal') {
        let maximumLengthError = 0;
        let maximumXyLength = 0;
        for (let i = 0; i < texture.data.length; i += 4) {
          const red = texture.data[i];
          const green = texture.data[i + 1];
          const blue = texture.data[i + 2];
          if (red === undefined || green === undefined || blue === undefined)
            throw new Error(`${name}: incomplete normal pixel at byte ${i}`);
          const x = red / 127.5 - 1;
          const y = green / 127.5 - 1;
          const z = blue / 127.5 - 1;
          maximumXyLength = Math.max(maximumXyLength, x * x + y * y);
          maximumLengthError = Math.max(maximumLengthError, Math.abs(Math.hypot(x, y, z) - 1));
        }
        expect(maximumXyLength, name).toBeLessThanOrEqual(1);
        expect(maximumLengthError, name).toBeLessThan(0.005);
      }
    }
  });

  it('publishes all nine packed impulse-noise mips', () => {
    const texture = textureOutputs.get(
      EngineContent.water.textures['impulse-noise'],
    ) as unknown as TextureAsset;
    expect(texture.data.byteLength).toBe(349524);
  });

  it('publishes exactly the EngineContent GUID set from its Pack sources', async () => {
    const built = new Set(textureOutputs.keys());
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
        sum += srgbToLinear(r / 255);
      }
      decodedMeans.push(sum / level.length);
    }
    expect(nonGrayOpaqueTexels).toBe(0);
    expect(offset).toBe(bytes.length);
    const [base = Number.NaN] = decodedMeans;
    for (const value of decodedMeans) expect(Math.abs(value - base)).toBeLessThan(0.004);
    const last = bytes.subarray(bytes.length - 4);
    expect(last[0]).toBe(Math.round(linearToSrgb(expected) * 255));
  });

  it('round-trips the sRGB transfer function', () => {
    for (let index = 0; index <= 32; index++) {
      const value = index / 32;
      expect(srgbToLinear(linearToSrgb(value))).toBeCloseTo(value, 6);
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
