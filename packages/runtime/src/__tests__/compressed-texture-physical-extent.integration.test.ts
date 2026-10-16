import { numMipLevels } from '@forgeax/engine-assets-runtime';
import { ok, type RhiCaps } from '@forgeax/engine-rhi';
import { deriveTextureLayout, type TextureAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';

type TextureCall = { readonly size: { readonly width: number; readonly height: number } };
type WriteCall = {
  readonly data: Uint8Array;
  readonly layout: { readonly bytesPerRow: number; readonly rowsPerImage: number };
  readonly size: { readonly width: number; readonly height: number };
};

const caps: RhiCaps = {
  backendKind: 'webgpu',
  compute: true,
  timestampQuery: false,
  timestampPeriodNanoseconds: null,
  indirectDrawing: false,
  textureCompressionBc: true,
  textureCompressionEtc2: false,
  textureCompressionAstc: false,
  multiDrawIndirect: false,
  pushConstants: false,
  textureBindingArray: false,
  samplerAliasing: false,
  firstInstanceIndirect: false,
  storageBuffer: true,
  storageTexture: false,
  rgba16floatRenderable: true,
  rg11b10ufloatRenderable: false,
  float32Filterable: false,
  textureImport: false,
  externalTexture: false,
  maxColorAttachments: 8,
};

function makeStore(calls: { create: TextureCall[]; writes: WriteCall[] }): GpuResidencyCache {
  const store = new GpuResidencyCache();
  const texture = { tag: 'texture' };
  store.configureGpuDevice(
    {
      limits: { maxTextureDimension2D: 16384 },
      createTexture: (descriptor: TextureCall) => {
        calls.create.push(descriptor);
        return ok(texture);
      },
      createTextureView: () => ok({ tag: 'view' }),
      destroyTexture: () => ok(undefined),
      queue: {
        writeTexture: (
          _dst: unknown,
          data: Uint8Array,
          layout: WriteCall['layout'],
          size: WriteCall['size'],
        ) => {
          calls.writes.push({ data, layout, size });
          return ok(undefined);
        },
        submit: () => ok(undefined),
      },
    } as never,
    undefined,
    (() => ok(toShared<'EquirectAsset'>(1))) as never,
    caps,
  );
  return store;
}

function compressedPod(): TextureAsset {
  const shape = { viewDimension: '2d', extent: { width: 2085, height: 1573 } } as const;
  const mips = { kind: 'packed', levelCount: numMipLevels(shape.extent) } as const;
  const layout = deriveTextureLayout({ shape, format: 'bc7-rgba-unorm', mips }).unwrap();
  const bytes = new Uint8Array(layout.byteLength);
  for (const level of layout.levels)
    bytes.fill(level.level + 1, level.byteOffset, level.byteOffset + level.byteLength);
  return {
    kind: 'texture',
    shape,
    format: 'bc7-rgba-unorm',
    data: bytes,
    colorSpace: 'linear',
    mips,
  };
}

describe('compressed texture physical extent recorded-RHI witness [w36]', () => {
  it('allocates and uploads BC7 physical extents while preserving logical asset metadata', () => {
    const calls = { create: [] as TextureCall[], writes: [] as WriteCall[] };
    const pod = compressedPod();
    const expected = deriveTextureLayout(pod).unwrap().levels;

    const result = makeStore(calls).ensureResident(toShared<'TextureAsset'>(36), pod);
    if (!result.ok) throw result.error;

    expect(pod.shape.extent.width).toBe(2085);
    expect(pod.shape.extent.height).toBe(1573);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]?.size).toMatchObject({ width: 2088, height: 1576 });
    expect(calls.writes).toHaveLength(expected.length);
    for (const [index, level] of expected.entries()) {
      const write = calls.writes[index];
      expect(write?.size).toMatchObject({
        width: level.physicalWidth,
        height: level.physicalHeight,
      });
      expect(write?.layout).toMatchObject({
        bytesPerRow: level.bytesPerRow,
        rowsPerImage: level.rowsPerImage,
      });
      expect(write?.data.byteLength).toBe(level.byteLength);
      expect(write?.data[0]).toBe(level.level + 1);
    }
  });

  it('keeps the uncompressed allocation and upload extent logical', () => {
    const calls = { create: [] as TextureCall[], writes: [] as WriteCall[] };
    const pod: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 17, height: 9 } },
      format: 'rgba8unorm',
      data: new Uint8Array(17 * 9 * 4),
      colorSpace: 'linear',
      mips: { kind: 'none' },
    };

    expect(makeStore(calls).ensureResident(toShared<'TextureAsset'>(37), pod).ok).toBe(true);

    expect(calls.create[0]?.size).toMatchObject({ width: 17, height: 9 });
    expect(calls.writes[0]?.size).toMatchObject({ width: 17, height: 9 });
    expect(calls.writes[0]?.layout).toMatchObject({ bytesPerRow: 68, rowsPerImage: 9 });
  });
});
