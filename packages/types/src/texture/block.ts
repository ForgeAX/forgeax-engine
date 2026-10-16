/** One texel block: 1x1 for uncompressed formats, the compression block otherwise. */
export interface TextureFormatBlock {
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly bytesPerBlock: number;
}

function block(blockWidth: number, blockHeight: number, bytesPerBlock: number): TextureFormatBlock {
  return { blockWidth, blockHeight, bytesPerBlock };
}

export type CompressedTextureFormat = Extract<
  GPUTextureFormat,
  `bc${string}` | `etc2-${string}` | `eac-${string}` | `astc-${string}`
>;

const BLOCK_4X4_8 = block(4, 4, 8);
const BLOCK_4X4_16 = block(4, 4, 16);

// WebGPU "Compressed Texture Formats". Keyed by every compressed member of
// GPUTextureFormat, so a new platform format fails typecheck instead of
// silently falling back to a 1x1 texel layout.
const COMPRESSED_BLOCKS: Readonly<Record<CompressedTextureFormat, TextureFormatBlock>> = {
  'bc1-rgba-unorm': BLOCK_4X4_8,
  'bc1-rgba-unorm-srgb': BLOCK_4X4_8,
  'bc4-r-unorm': BLOCK_4X4_8,
  'bc4-r-snorm': BLOCK_4X4_8,
  'etc2-rgb8unorm': BLOCK_4X4_8,
  'etc2-rgb8unorm-srgb': BLOCK_4X4_8,
  'etc2-rgb8a1unorm': BLOCK_4X4_8,
  'etc2-rgb8a1unorm-srgb': BLOCK_4X4_8,
  'eac-r11unorm': BLOCK_4X4_8,
  'eac-r11snorm': BLOCK_4X4_8,
  'bc2-rgba-unorm': BLOCK_4X4_16,
  'bc2-rgba-unorm-srgb': BLOCK_4X4_16,
  'bc3-rgba-unorm': BLOCK_4X4_16,
  'bc3-rgba-unorm-srgb': BLOCK_4X4_16,
  'bc5-rg-unorm': BLOCK_4X4_16,
  'bc5-rg-snorm': BLOCK_4X4_16,
  'bc6h-rgb-ufloat': BLOCK_4X4_16,
  'bc6h-rgb-float': BLOCK_4X4_16,
  'bc7-rgba-unorm': BLOCK_4X4_16,
  'bc7-rgba-unorm-srgb': BLOCK_4X4_16,
  'etc2-rgba8unorm': BLOCK_4X4_16,
  'etc2-rgba8unorm-srgb': BLOCK_4X4_16,
  'eac-rg11unorm': BLOCK_4X4_16,
  'eac-rg11snorm': BLOCK_4X4_16,
  'astc-4x4-unorm': block(4, 4, 16),
  'astc-4x4-unorm-srgb': block(4, 4, 16),
  'astc-5x4-unorm': block(5, 4, 16),
  'astc-5x4-unorm-srgb': block(5, 4, 16),
  'astc-5x5-unorm': block(5, 5, 16),
  'astc-5x5-unorm-srgb': block(5, 5, 16),
  'astc-6x5-unorm': block(6, 5, 16),
  'astc-6x5-unorm-srgb': block(6, 5, 16),
  'astc-6x6-unorm': block(6, 6, 16),
  'astc-6x6-unorm-srgb': block(6, 6, 16),
  'astc-8x5-unorm': block(8, 5, 16),
  'astc-8x5-unorm-srgb': block(8, 5, 16),
  'astc-8x6-unorm': block(8, 6, 16),
  'astc-8x6-unorm-srgb': block(8, 6, 16),
  'astc-8x8-unorm': block(8, 8, 16),
  'astc-8x8-unorm-srgb': block(8, 8, 16),
  'astc-10x5-unorm': block(10, 5, 16),
  'astc-10x5-unorm-srgb': block(10, 5, 16),
  'astc-10x6-unorm': block(10, 6, 16),
  'astc-10x6-unorm-srgb': block(10, 6, 16),
  'astc-10x8-unorm': block(10, 8, 16),
  'astc-10x8-unorm-srgb': block(10, 8, 16),
  'astc-10x10-unorm': block(10, 10, 16),
  'astc-10x10-unorm-srgb': block(10, 10, 16),
  'astc-12x10-unorm': block(12, 10, 16),
  'astc-12x10-unorm-srgb': block(12, 10, 16),
  'astc-12x12-unorm': block(12, 12, 16),
  'astc-12x12-unorm-srgb': block(12, 12, 16),
};

/** True iff `format` is a WebGPU block-compressed format. */
export function isCompressedFormat(format: GPUTextureFormat): format is CompressedTextureFormat {
  return Object.hasOwn(COMPRESSED_BLOCKS, format);
}

/** Texel block footprint and byte size of one `format` block. */
export function textureFormatBlock(format: GPUTextureFormat): TextureFormatBlock {
  if (isCompressedFormat(format)) return COMPRESSED_BLOCKS[format];
  switch (format) {
    case 'r8unorm':
    case 'r8snorm':
    case 'r8uint':
    case 'r8sint':
      return block(1, 1, 1);
    case 'rg8unorm':
    case 'rg8snorm':
    case 'rg8uint':
    case 'rg8sint':
    case 'r16uint':
    case 'r16sint':
    case 'r16float':
      return block(1, 1, 2);
    case 'rgba16uint':
    case 'rgba16sint':
    case 'rgba16float':
    case 'rg32uint':
    case 'rg32sint':
    case 'rg32float':
      return block(1, 1, 8);
    case 'rgba32uint':
    case 'rgba32sint':
    case 'rgba32float':
      return block(1, 1, 16);
    default:
      return block(1, 1, 4);
  }
}
