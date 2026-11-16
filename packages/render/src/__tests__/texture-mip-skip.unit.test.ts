import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { deriveTextureLayout, type TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { residentTextureChain, skipTextureMips } from '../device/texture-mip-skip';
import { worldRenderResources } from '../publication/resource-scope';

function packedRgba8(
  width: number,
  height: number,
  extra: Partial<TextureAsset> = {},
  levelCount = Math.floor(Math.log2(Math.max(width, height))) + 1,
): TextureAsset {
  const shape = { viewDimension: '2d' as const, extent: { width, height } };
  const mips = { kind: 'packed' as const, levelCount };
  const layout = deriveTextureLayout({ shape, format: 'rgba8unorm', mips }).unwrap();
  const data = new Uint8Array(layout.byteLength);
  // Each level is filled with its own index so a projection is checkable byte for byte.
  for (const level of layout.levels)
    data.fill(level.level + 1, level.byteOffset, level.byteOffset + level.byteLength);
  return {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape,
    mips,
    data,
    ...extra,
  };
}

describe('skipTextureMips', () => {
  const atlas = packedRgba8(2048, 2048, { skippableMips: true });

  it('keeps the asset identity when the skip is zero', () => {
    expect(atlas.data.byteLength).toBe(22_369_620);
    expect(skipTextureMips(atlas, 0)).toBe(atlas);
  });

  it('starts the chain one or two levels down with halved extents and bytes', () => {
    const one = skipTextureMips(atlas, 1);
    expect(one.shape).toEqual({ viewDimension: '2d', extent: { width: 1024, height: 1024 } });
    expect(one.mips).toEqual({ kind: 'packed', levelCount: 11 });
    expect(one.data.byteLength).toBe(5_592_404);
    expect(one.data[0]).toBe(2);
    expect(one.data.buffer).toBe(atlas.data.buffer);

    const two = skipTextureMips(atlas, 2);
    expect(two.shape).toEqual({ viewDimension: '2d', extent: { width: 512, height: 512 } });
    expect(two.mips).toEqual({ kind: 'packed', levelCount: 10 });
    expect(two.data.byteLength).toBe(1_398_100);
    expect(two.data[0]).toBe(3);
    expect(two.data.at(-1)).toBe(12);
    expect(two.colorSpace).toBe(atlas.colorSpace);
    expect(two.format).toBe(atlas.format);
    // The projection is itself a valid packed texture with a self-consistent layout.
    expect(deriveTextureLayout({ ...two, actualByteLength: two.data.byteLength }).ok).toBe(true);
  });

  it('keeps at least the final level when the skip exceeds the chain', () => {
    const small = packedRgba8(8, 4, { skippableMips: true });
    const projected = skipTextureMips(small, 99);
    expect(projected.shape).toEqual({ viewDimension: '2d', extent: { width: 1, height: 1 } });
    expect(projected.mips).toEqual({ kind: 'packed', levelCount: 1 });
    expect(Array.from(projected.data)).toEqual([4, 4, 4, 4]);
  });

  it('leaves textures without the opt-in untouched', () => {
    const data = packedRgba8(64, 64);
    expect(skipTextureMips(data, 2)).toBe(data);
    const declined = packedRgba8(64, 64, { skippableMips: false });
    expect(skipTextureMips(declined, 2)).toBe(declined);
  });

  it('leaves single-level, generated and 3D textures untouched', () => {
    const none: TextureAsset = {
      ...packedRgba8(4, 4, { skippableMips: true }, 1),
      mips: { kind: 'none' },
    };
    expect(skipTextureMips(none, 2)).toBe(none);
    const single = packedRgba8(4, 4, { skippableMips: true }, 1);
    expect(skipTextureMips(single, 2)).toBe(single);
    const generate: TextureAsset = {
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      mips: { kind: 'generate' },
      data: new Uint8Array(64),
      skippableMips: true,
    };
    expect(skipTextureMips(generate, 2)).toBe(generate);
    const volume: TextureAsset = {
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
      mips: { kind: 'packed', levelCount: 2 },
      data: new Uint8Array(36),
      skippableMips: true,
    };
    expect(skipTextureMips(volume, 1)).toBe(volume);
  });

  it('keeps every array layer and drops whole levels across layers', () => {
    const shape = {
      viewDimension: '2d-array' as const,
      extent: { width: 4, height: 4, layers: 3 },
    };
    const mips = { kind: 'packed' as const, levelCount: 3 };
    const layout = deriveTextureLayout({ shape, format: 'rgba8unorm', mips }).unwrap();
    const array: TextureAsset = {
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape,
      mips,
      data: new Uint8Array(layout.byteLength),
      skippableMips: true,
    };
    const projected = skipTextureMips(array, 1);
    expect(projected.shape).toEqual({
      viewDimension: '2d-array',
      extent: { width: 2, height: 2, layers: 3 },
    });
    expect(projected.data.byteLength).toBe((2 * 2 + 1) * 4 * 3);
  });

  it('stops before a compressed base level would leave the block grid', () => {
    const shape = { viewDimension: '2d' as const, extent: { width: 16, height: 16 } };
    const mips = { kind: 'packed' as const, levelCount: 5 };
    const layout = deriveTextureLayout({ shape, format: 'bc1-rgba-unorm', mips }).unwrap();
    const bc1: TextureAsset = {
      kind: 'texture',
      format: 'bc1-rgba-unorm',
      colorSpace: 'linear',
      shape,
      mips,
      data: new Uint8Array(layout.byteLength),
      skippableMips: true,
    };
    const one = skipTextureMips(bc1, 1);
    expect(one.shape.extent).toEqual({ width: 8, height: 8 });
    expect(one.data.byteLength).toBe(layout.byteLength - (layout.levels[0]?.byteLength ?? 0));
    // 16 -> 8 -> 4 stays on the 4x4 block grid; a 2x2 base would not.
    const many = skipTextureMips(bc1, 4);
    expect(many.shape.extent).toEqual({ width: 4, height: 4 });
    expect(many.mips).toEqual({ kind: 'packed', levelCount: 3 });
  });

  it.each([
    'astc-4x4-unorm',
    'etc2-rgba8unorm',
  ] as const)('retains a complete aligned %s chain', (format) => {
    const shape = { viewDimension: '2d' as const, extent: { width: 16, height: 16 } };
    const mips = { kind: 'packed' as const, levelCount: 5 };
    const layout = deriveTextureLayout({ shape, format, mips }).unwrap();
    const texture: TextureAsset = {
      kind: 'texture',
      shape,
      mips,
      format,
      colorSpace: 'linear',
      data: new Uint8Array(layout.byteLength),
      skippableMips: true,
    };
    const projected = skipTextureMips(texture, 4);
    expect(projected.shape.extent).toEqual({ width: 4, height: 4 });
    expect(projected.mips).toEqual({ kind: 'packed', levelCount: 3 });
    expect(
      deriveTextureLayout({ ...projected, actualByteLength: projected.data.byteLength }).ok,
    ).toBe(true);
  });
});

describe('GpuResidencyCache textureMipSkip', () => {
  async function upload(texture: TextureAsset, options?: { textureMipSkip?: number }) {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const writes = vi.spyOn(device.queue, 'writeTexture');
    const creates = vi.spyOn(device, 'createTexture');
    const store = new GpuResidencyCache(undefined, options);
    store.configureGpuDevice(device, undefined, device.caps);
    const assets = new AssetRegistry();
    const world = new World({ assets });
    try {
      const entry = store
        .ensureResident(assets.create(texture).unwrap(), texture, worldRenderResources(world))
        .unwrap();
      return {
        receipt: entry.receipt,
        created: creates.mock.calls.map(([descriptor]) => ({
          size: descriptor.size,
          mipLevelCount: descriptor.mipLevelCount,
        })),
        writes: writes.mock.calls.map(([destination, bytes, , extent]) => ({
          mip: destination.mipLevel,
          bytes: (bytes as Uint8Array).byteLength,
          first: (bytes as Uint8Array)[0],
          extent,
        })),
      };
    } finally {
      store.destroyAll();
      assets.dispose();
    }
  }

  it('uploads the authored chain unchanged by default', async () => {
    const texture = packedRgba8(8, 8, { skippableMips: true });
    const expected = {
      receipt: expect.objectContaining({ mipLevelCount: 4, bytes: 340 }),
      created: [{ size: { width: 8, height: 8, depthOrArrayLayers: 1 }, mipLevelCount: 4 }],
      writes: [8, 4, 2, 1].map((width, mip) => ({
        mip,
        bytes: width * width * 4,
        first: mip + 1,
        extent: { width, height: width, depthOrArrayLayers: 1 },
      })),
    };
    expect(await upload(texture)).toEqual(expected);
    expect(await upload(texture, { textureMipSkip: 0 })).toEqual(expected);
  });

  it('allocates and writes only the retained levels of an opted-in texture', async () => {
    const result = await upload(packedRgba8(8, 8, { skippableMips: true }), {
      textureMipSkip: 2,
    });
    expect(result.created).toEqual([
      { size: { width: 2, height: 2, depthOrArrayLayers: 1 }, mipLevelCount: 2 },
    ]);
    expect(result.writes).toEqual([
      { mip: 0, bytes: 16, first: 3, extent: { width: 2, height: 2, depthOrArrayLayers: 1 } },
      { mip: 1, bytes: 4, first: 4, extent: { width: 1, height: 1, depthOrArrayLayers: 1 } },
    ]);
    expect(result.receipt).toMatchObject({
      mipLevelCount: 2,
      bytes: 20,
      shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    });
  });

  it('describes the resident chain of a skipped upload from its receipt', async () => {
    const texture = packedRgba8(8, 8, { skippableMips: true });
    const skipped = await upload(texture, { textureMipSkip: 2 });
    expect(residentTextureChain(texture, skipped.receipt)).toEqual({
      shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
      mips: { kind: 'packed', levelCount: 2 },
    });
    const full = await upload(texture);
    expect(residentTextureChain(texture, full.receipt)).toBe(texture);
  });

  it('keeps the authored description for chains the upload does not shorten', () => {
    const generated = packedRgba8(8, 8, { mips: { kind: 'generate' } }, 1);
    const receipt = { shape: generated.shape, mipLevelCount: 1 };
    expect(residentTextureChain(generated, receipt)).toBe(generated);
    const packed = packedRgba8(8, 8);
    expect(residentTextureChain(packed, { shape: packed.shape, mipLevelCount: 4 })).toBe(packed);
  });

  it('keeps textures without the opt-in at full size under a skip', async () => {
    const result = await upload(packedRgba8(8, 8), { textureMipSkip: 2 });
    expect(result.created).toEqual([
      { size: { width: 8, height: 8, depthOrArrayLayers: 1 }, mipLevelCount: 4 },
    ]);
    expect(result.receipt).toMatchObject({ mipLevelCount: 4, bytes: 340 });
  });

  it('rejects a skip that is not a non-negative integer', () => {
    for (const textureMipSkip of [-1, 0.5, Number.NaN, 64])
      expect(() => new GpuResidencyCache(undefined, { textureMipSkip })).toThrow(RangeError);
  });
});
