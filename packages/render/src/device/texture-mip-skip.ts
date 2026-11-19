import {
  deriveTextureLayout,
  mipDimension,
  type TextureAsset,
  type TextureMipPolicy,
  type TextureShape,
  textureFormatBlock,
} from '@forgeax/engine-types';

/** The part of a texture description that a mip skip changes. */
export interface ResidentTextureChain<S extends TextureShape = TextureShape> {
  readonly shape: S;
  readonly mips: TextureMipPolicy;
}

/** Shapes a mip skip can shorten: 3D textures always keep their authored chain. */
type SkippableTextureShape = Exclude<TextureShape, { readonly viewDimension: '3d' }>;

/** Upper bound that covers every chain a 32-bit extent can describe. */
const MAX_TEXTURE_MIP_SKIP = 32;

/** Validate `RendererOptions.textureMipSkip`; zero keeps every authored level. */
export function assertTextureMipSkip(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TEXTURE_MIP_SKIP)
    throw new RangeError(
      `textureMipSkip must be an integer from 0 to ${MAX_TEXTURE_MIP_SKIP}; received ${value}`,
    );
}

/**
 * Project a native texture to the GPU view of its packed chain that starts
 * `levels` below the authored base. Only textures that declare
 * `skippableMips: true` with a packed 2D or 2D-array chain qualify. The final
 * level always remains, and a block-compressed base stays on its block grid.
 * Any other input, or a zero skip, returns the same object. The projected bytes
 * are a view of the source bytes; nothing is resampled.
 */
export function skipTextureMips(texture: TextureAsset, levels: number): TextureAsset {
  if (
    levels <= 0 ||
    texture.skippableMips !== true ||
    texture.encoding !== undefined ||
    texture.mips.kind !== 'packed' ||
    texture.shape.viewDimension === '3d'
  )
    return texture;
  const { width, height } = texture.shape.extent;
  const block = textureFormatBlock(texture.format);
  let skip = Math.min(levels, texture.mips.levelCount - 1);
  while (
    skip > 0 &&
    (mipDimension(width, skip) % block.blockWidth !== 0 ||
      mipDimension(height, skip) % block.blockHeight !== 0)
  )
    skip -= 1;
  if (skip === 0) return texture;
  const layout = deriveTextureLayout(texture);
  if (!layout.ok) return texture;
  const { levels: chain, byteLength } = layout.value;
  const first = chain[skip];
  // A malformed payload keeps its authored form so the ordinary upload reports it.
  if (first === undefined || texture.data.byteLength !== byteLength) return texture;
  const extent = { width: first.width, height: first.height };
  return {
    ...texture,
    shape:
      texture.shape.viewDimension === '2d'
        ? { viewDimension: '2d', extent }
        : {
            viewDimension: '2d-array',
            extent: { ...extent, layers: texture.shape.extent.layers },
          },
    mips: { kind: 'packed', levelCount: texture.mips.levelCount - skip },
    data: texture.data.subarray(first.byteOffset, byteLength),
  };
}

/**
 * Shape and mip policy of the chain that is resident for `texture`. A receipt
 * with fewer levels than the authored packed chain records a skipped upload,
 * and its shape is the resident base level; any other receipt describes the
 * authored chain. GPU consumers that import the resident texture by descriptor
 * use this instead of the authored extent.
 */
export function residentTextureChain<S extends TextureShape>(
  texture: ResidentTextureChain<S>,
  receipt: { readonly shape: TextureShape; readonly mipLevelCount: number },
): ResidentTextureChain<S | SkippableTextureShape> {
  if (
    texture.mips.kind !== 'packed' ||
    receipt.mipLevelCount >= texture.mips.levelCount ||
    receipt.shape.viewDimension === '3d'
  )
    return texture;
  return { shape: receipt.shape, mips: { kind: 'packed', levelCount: receipt.mipLevelCount } };
}
