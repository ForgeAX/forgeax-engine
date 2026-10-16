import { describe, expect, it } from 'vitest';
import { COOKIE_SLICE_MIP_CHAIN_BYTES } from '../prepare/extended-lighting/resources';
import { prepareCookieProjection } from '../prepare/extended-lighting/spot-modifiers';

function chainOf(projection: ReturnType<typeof prepareCookieProjection>): Uint8Array {
  if (projection?.source.kind !== 'mip-chain') throw new Error('expected a CPU mip chain');
  return projection.source.data;
}

describe('Spot modifier projection', () => {
  it('projects non-square sRGB RGBA data once into linear fixed-size slices', () => {
    const asset = {
      kind: 'texture' as const,
      shape: { viewDimension: '2d' as const, extent: { width: 2, height: 1 } },
      format: 'rgba8unorm-srgb' as const,
      colorSpace: 'srgb' as const,
      mipmap: false,
      mips: { kind: 'none' as const },
      data: new Uint8Array([128, 0, 0, 128, 0, 255, 0, 255]),
    };
    const projection = prepareCookieProjection(asset);

    expect(projection).toBeDefined();
    expect(chainOf(projection).byteLength).toBe(COOKIE_SLICE_MIP_CHAIN_BYTES);
    expect(projection?.aspect).toBe(2);
    expect(projection?.matrix[0]).toBeCloseTo(0.5, 6);
    expect(projection?.matrix[5]).toBe(1);
    // The first source texel is sampled near its center. 128 sRGB is not
    // copied as 128 linear; it is converted to roughly 55 linear bytes.
    expect(chainOf(projection)[0]).toBeLessThan(70);
    expect(chainOf(projection)[1]).toBe(0);
    expect(chainOf(projection)[3]).toBe(128);
    const right = 256 * 4 - 4;
    expect(chainOf(projection)[right + 1]).toBeGreaterThan(240);
    expect(projection).toBe(prepareCookieProjection(asset));
  });

  const oneTexel = (format: GPUTextureFormat, colorSpace: 'srgb' | 'linear', data: Uint8Array) => ({
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: 1, height: 1 } },
    format,
    colorSpace,
    mips: { kind: 'none' as const },
    data,
  });
  const halves = (...values: number[]) => {
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    for (const [index, value] of values.entries()) {
      // Exact half encodings for the small set used below.
      const bits = { 0: 0x0000, 0.5: 0x3800, 1: 0x3c00, 4: 0x4400 }[value] ?? Number.NaN;
      view.setUint16(index * 2, bits, true);
    }
    return bytes;
  };

  it.each([
    ['rgba8unorm', 'linear', new Uint8Array([255, 128, 0, 255]), [255, 128, 0, 255]],
    ['bgra8unorm', 'linear', new Uint8Array([0, 128, 255, 255]), [255, 128, 0, 255]],
    ['bgra8unorm-srgb', 'srgb', new Uint8Array([0, 0, 255, 255]), [255, 0, 0, 255]],
    ['r8unorm', 'linear', new Uint8Array([64]), [64, 64, 64, 255]],
    // HDR keeps values below 1 and clips above: 0.5 -> 128, 4 -> 255.
    ['rgba16float', 'linear', halves(4, 0.5, 0, 1), [255, 128, 0, 255]],
    [
      'rgba32float',
      'linear',
      new Uint8Array(new Float32Array([0.5, 2, 0, 1]).buffer),
      [128, 255, 0, 255],
    ],
  ] as const)('decodes %s sources into the linear slice', (format, colorSpace, data, expected) => {
    const projection = prepareCookieProjection(oneTexel(format, colorSpace, data));
    expect(projection).toBeDefined();
    const tail = chainOf(projection).subarray((chainOf(projection).byteLength ?? 0) - 4);
    expect([...(tail ?? [])]).toEqual(expected);
  });

  it('reads only level 0 of a packed mip chain', () => {
    const projection = prepareCookieProjection({
      kind: 'texture' as const,
      shape: { viewDimension: '2d' as const, extent: { width: 2, height: 2 } },
      format: 'rgba8unorm' as const,
      colorSpace: 'linear' as const,
      mips: { kind: 'packed' as const, levelCount: 2 },
      data: new Uint8Array([...Array(4).fill([0, 255, 0, 255]).flat(), 255, 0, 0, 255]),
    });
    const tail = chainOf(projection).subarray((chainOf(projection).byteLength ?? 0) - 4);
    expect([...(tail ?? [])]).toEqual([0, 255, 0, 255]);
  });

  it('hands a block-compressed source to the GPU resample instead of decoding it', () => {
    const asset = oneTexel('bc7-rgba-unorm-srgb', 'srgb', new Uint8Array(16));
    const projection = prepareCookieProjection(asset);
    expect(projection?.source).toEqual({ kind: 'gpu-resample', asset });
    expect(projection?.aspect).toBe(1);
  });

  it.each([
    ['bc7-rgba-unorm-srgb', 'linear', 16],
    ['bc7-rgba-unorm', 'srgb', 16],
    ['bc7-rgba-unorm-srgb', 'srgb', 15],
    ['rgba8unorm', 'srgb', 4],
    ['rgba8unorm-srgb', 'linear', 4],
    ['rgba16float', 'linear', 4],
  ] as const)('rejects %s (%s, %i bytes) instead of binding raw bytes', (format, space, bytes) => {
    expect(prepareCookieProjection(oneTexel(format, space, new Uint8Array(bytes)))).toBeUndefined();
  });

  it('box-filters large sources and appends a mean-preserving mip chain', () => {
    const width = 1024;
    const height = 512;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        // One-texel checker: bilinear point sampling of a 4x downscale would
        // alias to pure black or white; the area filter must land on grey.
        const on = (x + y) % 2 === 0 ? 255 : 0;
        data[offset] = on;
        data[offset + 1] = x < width / 2 ? 255 : 0;
        data[offset + 2] = 0;
        data[offset + 3] = 255;
      }
    }
    const projection = prepareCookieProjection({
      kind: 'texture' as const,
      shape: { viewDimension: '2d' as const, extent: { width, height } },
      format: 'rgba8unorm' as const,
      colorSpace: 'linear' as const,
      mips: { kind: 'none' as const },
      data,
    });
    expect(projection).toBeDefined();
    const chain = chainOf(projection);
    for (let texel = 0; texel < 256 * 256; texel += 97) {
      expect(Math.abs((chain[texel * 4] ?? 0) - 128)).toBeLessThanOrEqual(1);
    }
    // Left half green, right half black: level 0 keeps the edge sharp.
    expect(chain[(10 * 256 + 10) * 4 + 1]).toBe(255);
    expect(chain[(10 * 256 + 245) * 4 + 1]).toBe(0);
    // The 1x1 tail is the linear mean of the whole slice.
    const tail = chain.subarray(chain.byteLength - 4);
    expect(Math.abs((tail[0] ?? 0) - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs((tail[1] ?? 0) - 128)).toBeLessThanOrEqual(1);
    expect(tail[3]).toBe(255);
    // Level 1 (128x128) starts right after level 0.
    const level1 = chain.subarray(256 * 256 * 4);
    expect(level1[(5 * 128 + 5) * 4 + 1]).toBe(255);
    expect(level1[(5 * 128 + 122) * 4 + 1]).toBe(0);
  });
});
