import { describe, expect, it } from 'vitest';
import { isCompressedFormat } from '../texture/block.js';
import { deriveTextureLayout, type TextureMipLayout } from '../texture/layout.js';

function uploadLayout(
  format: GPUTextureFormat,
  width: number,
  height: number,
  levelCount: number,
): readonly TextureMipLayout[] {
  return deriveTextureLayout({
    shape: { viewDimension: '2d', extent: { width, height } },
    format,
    mips: levelCount === 1 ? { kind: 'none' } : { kind: 'packed', levelCount },
  }).unwrap().levels;
}

function totalBytes(layout: readonly TextureMipLayout[]): number {
  return layout.reduce((acc, l) => acc + l.byteLength, 0);
}

describe('canonical texture layout', () => {
  it.each([
    ['etc2-rgb8unorm', 8],
    ['etc2-rgb8unorm-srgb', 8],
    ['etc2-rgb8a1unorm', 8],
    ['etc2-rgb8a1unorm-srgb', 8],
    ['etc2-rgba8unorm', 16],
    ['etc2-rgba8unorm-srgb', 16],
  ] as const)('keeps the ETC2 block size for %s across mip and layer strides', (format, bytes) => {
    const layout = deriveTextureLayout({
      shape: { viewDimension: '2d-array', extent: { width: 7, height: 5, layers: 2 } },
      format,
      mips: { kind: 'packed', levelCount: 3 },
    }).unwrap();
    expect(
      layout.levels.map((level) => [level.bytesPerRow, level.byteOffset, level.byteLength]),
    ).toEqual([
      [bytes * 2, 0, bytes * 8],
      [bytes, bytes * 8, bytes * 2],
      [bytes, bytes * 10, bytes * 2],
    ]);
    expect(layout.byteLength).toBe(bytes * 12);
  });

  it.each([
    ['bc4-r-unorm', 4, 4, 8],
    ['bc4-r-snorm', 4, 4, 8],
    ['eac-r11unorm', 4, 4, 8],
    ['eac-r11snorm', 4, 4, 8],
    ['eac-rg11unorm', 4, 4, 16],
    ['astc-5x4-unorm', 5, 4, 16],
    ['astc-8x5-unorm', 8, 5, 16],
    ['astc-12x12-unorm-srgb', 12, 12, 16],
  ] as const)('derives %s from its own block footprint', (format, blockW, blockH, bytes) => {
    const level = deriveTextureLayout({
      shape: { viewDimension: '2d', extent: { width: 13, height: 11 } },
      format,
      mips: { kind: 'none' },
    }).unwrap().levels[0];
    const columns = Math.ceil(13 / blockW);
    const rows = Math.ceil(11 / blockH);
    expect(level).toMatchObject({
      physicalWidth: columns * blockW,
      physicalHeight: rows * blockH,
      bytesPerRow: columns * bytes,
      rowsPerImage: rows,
      byteLength: columns * rows * bytes,
    });
  });

  it.each([
    ['2d', { viewDimension: '2d', extent: { width: 3, height: 5 } }, 1],
    ['2d-array', { viewDimension: '2d-array', extent: { width: 3, height: 5, layers: 3 } }, 3],
    ['3d', { viewDimension: '3d', extent: { width: 3, height: 5, depth: 5 } }, 5],
  ] as const)('%s is mip-major and image-major', (_name, shape, baseImages) => {
    const result = deriveTextureLayout({
      shape,
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 3 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.levels).toHaveLength(3);
    expect(result.value.levels[0]?.imagesPerMip).toBe(baseImages);
    expect(result.value.levels[1]?.imagesPerMip).toBe(
      shape.viewDimension === '2d-array' ? 3 : shape.viewDimension === '3d' ? 2 : 1,
    );
    expect(result.value.levels[0]?.byteOffset).toBe(0);
    expect(result.value.levels[1]?.byteOffset).toBe(result.value.levels[0]?.byteLength);
    expect(result.value.byteLength).toBe(
      result.value.levels.reduce((sum, level) => sum + level.byteLength, 0),
    );
  });

  it('keeps array layers but shrinks 3d depth at odd mip extents', () => {
    const array = deriveTextureLayout({
      shape: { viewDimension: '2d-array', extent: { width: 5, height: 3, layers: 3 } },
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 3 },
    });
    const volume = deriveTextureLayout({
      shape: { viewDimension: '3d', extent: { width: 5, height: 3, depth: 5 } },
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 3 },
    });

    expect(array.ok && array.value.levels.map((level) => level.imagesPerMip)).toEqual([3, 3, 3]);
    expect(volume.ok && volume.value.levels.map((level) => level.imagesPerMip)).toEqual([5, 2, 1]);
  });

  it.each([
    'etc2-rgba8unorm',
    'etc2-rgba8unorm-srgb',
  ] as const)('%s uses the 16-byte ETC2 RGBA8 block size', (format) => {
    const result = deriveTextureLayout({
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      format,
      mips: { kind: 'none' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.levels[0]).toMatchObject({
      bytesPerRow: 16,
      rowsPerImage: 1,
      byteLength: 16,
    });
    expect(result.value.byteLength).toBe(16);

    const nonAligned = deriveTextureLayout({
      shape: { viewDimension: '2d', extent: { width: 5, height: 4 } },
      format,
      mips: { kind: 'none' },
    });

    expect(nonAligned.ok).toBe(true);
    if (!nonAligned.ok) return;
    expect(nonAligned.value.levels[0]).toMatchObject({
      bytesPerRow: 32,
      rowsPerImage: 1,
      byteLength: 32,
    });
    expect(nonAligned.value.byteLength).toBe(32);
  });

  it('rejects wrong canonical byte length and order', () => {
    const result = deriveTextureLayout({
      shape: { viewDimension: '2d-array', extent: { width: 3, height: 5, layers: 2 } },
      format: 'r8unorm',
      mips: { kind: 'packed', levelCount: 2 },
      actualByteLength: 1,
      order: 'layer-major-before-mip',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'texture-packing-invalid' },
    });
  });
});

it('validates generated mips against only the authored base level while retaining GPU layout', () => {
  const result = deriveTextureLayout({
    shape: { viewDimension: '2d', extent: { width: 128, height: 128 } },
    format: 'rgba8unorm-srgb',
    mips: { kind: 'generate' },
    actualByteLength: 65536,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.levels).toHaveLength(8);
  expect(result.value.byteLength).toBe(87380);
  expect(
    deriveTextureLayout({
      shape: result.value.shape,
      format: result.value.format,
      mips: { kind: 'packed', levelCount: 8 },
      actualByteLength: 65536,
    }).ok,
  ).toBe(false);
});

describe('compressed upload layout -- single-level block sizing', () => {
  // BC7 = 4x4 block, 16 bytes/block. bytesPerRow = ceil(w/4)*16.
  it.each([
    // [width, height, expectedBytesPerRow, expectedRowsPerImage]
    [4, 4, 16, 1], // exact single block
    [8, 8, 32, 2], // 2x2 blocks
    [7, 7, 32, 2], // non-4-multiple: ceil(7/4)=2 both axes
    [1, 1, 16, 1], // 1x1 tail pads to a full block
    [2, 2, 16, 1], // 2x2 tail pads to a full block
    [5, 3, 32, 1], // ceil(5/4)=2 -> 32 wide, ceil(3/4)=1 tall
    [16, 1, 64, 1], // wide sliver
  ])('bc7 %ix%i -> bytesPerRow=%i rowsPerImage=%i', (w, h, bpr, rpi) => {
    const layout = uploadLayout('bc7-rgba-unorm', w, h, 1);
    expect(layout).toHaveLength(1);
    const l = layout[0] as TextureMipLayout;
    expect(l.level).toBe(0);
    expect(l.width).toBe(w);
    expect(l.height).toBe(h);
    expect(l.bytesPerRow).toBe(bpr);
    expect(l.rowsPerImage).toBe(rpi);
    expect(l.byteOffset).toBe(0);
    expect(l.byteLength).toBe(bpr * rpi);
  });

  // BC1 / BC4 / ETC2-rgb8 / EAC-r11 = 4x4 block, 8 bytes/block (0.5 bpp).
  it.each([
    ['bc1-rgba-unorm', 8, 8, 16, 2],
    ['bc4-r-unorm', 4, 4, 8, 1],
    ['etc2-rgb8unorm', 16, 16, 32, 4],
    ['eac-r11unorm', 7, 5, 16, 2],
  ] as const)('%s %ix%i -> bytesPerRow=%i rowsPerImage=%i', (fmt, w, h, bpr, rpi) => {
    const l = uploadLayout(fmt, w, h, 1)[0] as TextureMipLayout;
    expect(l.bytesPerRow).toBe(bpr);
    expect(l.rowsPerImage).toBe(rpi);
  });

  // ASTC block dims come from the format name; all 16 bytes/block.
  it.each([
    ['astc-4x4-unorm', 8, 8, 32, 2],
    ['astc-6x6-unorm', 12, 12, 32, 2], // ceil(12/6)=2 -> 32, ceil(12/6)=2
    ['astc-8x8-unorm', 9, 9, 32, 2], // ceil(9/8)=2 both axes
    ['astc-5x4-unorm', 5, 4, 16, 1], // one 5-wide x 4-tall block
  ] as const)('%s %ix%i -> bytesPerRow=%i rowsPerImage=%i', (fmt, w, h, bpr, rpi) => {
    const l = uploadLayout(fmt, w, h, 1)[0] as TextureMipLayout;
    expect(l.bytesPerRow).toBe(bpr);
    expect(l.rowsPerImage).toBe(rpi);
  });

  // BC6H (HDR) = 4x4 block, 16 bytes/block -- the equirect HDR upload path.
  it('bc6h-rgb-ufloat 4x4 -> one 16-byte block', () => {
    const l = uploadLayout('bc6h-rgb-ufloat', 4, 4, 1)[0] as TextureMipLayout;
    expect(l.bytesPerRow).toBe(16);
    expect(l.rowsPerImage).toBe(1);
    expect(l.byteLength).toBe(16);
  });
});

describe('compressed upload layout -- mip-major offset accumulation', () => {
  it('bc7 8x8 4-level chain accumulates offsets with block-padded tails', () => {
    // levels: 8x8, 4x4, 2x2, 1x1 (2x2 and 1x1 pad up to a full 4x4 block)
    const layout = uploadLayout('bc7-rgba-unorm', 8, 8, 4);
    expect(layout).toHaveLength(4);

    const expected: readonly Pick<
      TextureMipLayout,
      'width' | 'height' | 'bytesPerRow' | 'rowsPerImage' | 'byteOffset' | 'byteLength'
    >[] = [
      { width: 8, height: 8, bytesPerRow: 32, rowsPerImage: 2, byteOffset: 0, byteLength: 64 },
      { width: 4, height: 4, bytesPerRow: 16, rowsPerImage: 1, byteOffset: 64, byteLength: 16 },
      { width: 2, height: 2, bytesPerRow: 16, rowsPerImage: 1, byteOffset: 80, byteLength: 16 },
      { width: 1, height: 1, bytesPerRow: 16, rowsPerImage: 1, byteOffset: 96, byteLength: 16 },
    ];
    for (let i = 0; i < expected.length; i++) {
      const l = layout[i] as TextureMipLayout;
      expect(l.level).toBe(i);
      expect({
        width: l.width,
        height: l.height,
        bytesPerRow: l.bytesPerRow,
        rowsPerImage: l.rowsPerImage,
        byteOffset: l.byteOffset,
        byteLength: l.byteLength,
      }).toEqual(expected[i]);
    }
    expect(totalBytes(layout)).toBe(112);
  });

  it('bc1 non-square 12x6 3-level chain (0.5bpp) offsets are contiguous', () => {
    // 12x6 -> 6x3 -> 3x1  (bc1 = 8 bytes/block, 4x4)
    const layout = uploadLayout('bc1-rgba-unorm', 12, 6, 3);
    // level0 12x6: bpr=ceil(12/4)*8=24, rpi=ceil(6/4)=2, len=48, off=0
    // level1 6x3:  bpr=ceil(6/4)*8=16, rpi=ceil(3/4)=1, len=16, off=48
    // level2 3x1:  bpr=ceil(3/4)*8=8,  rpi=1,           len=8,  off=64
    expect(layout.map((l) => l.byteOffset)).toEqual([0, 48, 64]);
    expect(layout.map((l) => l.byteLength)).toEqual([48, 16, 8]);
    expect(totalBytes(layout)).toBe(72);
  });

  it('single-level (no mip chain) returns one entry at offset 0', () => {
    const layout = uploadLayout('bc7-rgba-unorm', 256, 256, 1);
    expect(layout).toHaveLength(1);
    expect(layout[0]?.byteOffset).toBe(0);
  });
});

describe('compressed upload layout -- physical full-subresource copy extents', () => {
  it('aligns non-block-aligned BC7 copies to physical storage', () => {
    const layout = uploadLayout('bc7-rgba-unorm', 7, 5, 1);
    expect(layout[0]?.physicalWidth).toBe(8);
    expect(layout[0]?.physicalHeight).toBe(8);
  });

  it('aligns sub-block tail mip copies independently', () => {
    const layout = uploadLayout('bc7-rgba-unorm', 8, 8, 4);
    expect(layout[2]?.width).toBe(2);
    expect(layout[2]?.physicalWidth).toBe(4);
    expect(layout[2]?.physicalHeight).toBe(4);
    expect(layout[3]?.width).toBe(1);
    expect(layout[3]?.physicalWidth).toBe(4);
    expect(layout[3]?.physicalHeight).toBe(4);
  });

  it('aligns non-square ASTC copies with its own block dimensions', () => {
    const layout = uploadLayout('astc-8x5-unorm', 5, 3, 1);
    expect(layout[0]?.physicalWidth).toBe(8);
    expect(layout[0]?.physicalHeight).toBe(5);
  });
});

describe('isCompressedFormat', () => {
  it.each([
    ['bc7-rgba-unorm', true],
    ['bc4-r-snorm', true],
    ['eac-r11unorm', true],
    ['astc-10x8-unorm-srgb', true],
    ['rgba8unorm', false],
    ['rgba16float', false],
    ['r8unorm', false],
  ] as const)('%s -> %s', (format, compressed) => {
    expect(isCompressedFormat(format)).toBe(compressed);
  });
});
