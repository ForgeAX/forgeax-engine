import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
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
import { CONTENT_MESH_NAMES, EngineContent } from '../index';

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
  it('publishes exactly the EngineContent GUID set from its Pack sources', async () => {
    const built = new Set<string>();
    for (const pack of [meshesPack, checkerPack, materialsPack])
      for (const guid of (await outputs(pack)).keys()) built.add(guid);
    const declared = [
      ...Object.values(EngineContent.meshes),
      ...Object.values(EngineContent.textures),
      ...Object.values(EngineContent.samplers),
      ...Object.values(EngineContent.materials),
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
    const built = await outputs(checkerPack);
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
