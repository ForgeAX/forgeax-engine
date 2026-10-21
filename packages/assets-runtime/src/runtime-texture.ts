import {
  AssetError,
  deriveTextureLayout,
  err,
  ok,
  type Result,
  type TextureAsset,
  textureFormatBlock,
} from '@forgeax/engine-types';
import type { AssetLimits, PreparedAssetRanges } from './internal/asset-records';

/** Tightly packed texels/blocks for one region; z addresses an array layer or depth slice. */
export interface TextureRegion {
  readonly mipLevel?: number;
  readonly origin: { readonly x: number; readonly y: number; readonly z?: number };
  readonly size: {
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers?: number;
  };
  readonly data: Uint8Array;
}

function invalid(expected: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: 'supply a bounded texture region aligned to the format texel blocks and tightly packed input bytes',
    }),
  );
}

export function prepareRuntimeTextureRange(
  current: unknown,
  region: TextureRegion,
  limits: Required<AssetLimits>,
): Result<PreparedAssetRanges, AssetError> {
  if (
    current === null ||
    typeof current !== 'object' ||
    !('kind' in current) ||
    current.kind !== 'texture'
  )
    return invalid('a managed Texture reference');
  if (
    region === null ||
    typeof region !== 'object' ||
    region.origin === null ||
    typeof region.origin !== 'object' ||
    region.size === null ||
    typeof region.size !== 'object' ||
    !(region.data instanceof Uint8Array)
  )
    return invalid('an origin, extent and Uint8Array data');
  const texture = current as TextureAsset;
  if (texture.encoding !== undefined)
    return invalid('native texel/block bytes for region writes; replace encoded images in full');
  const layout = deriveTextureLayout(texture);
  if (!layout.ok) return invalid(layout.error.expected);
  const levelIndex = region.mipLevel ?? 0;
  const level = layout.value.levels[levelIndex];
  if (
    !Number.isSafeInteger(levelIndex) ||
    level === undefined ||
    (texture.mips.kind === 'generate' && levelIndex !== 0)
  )
    return invalid('an authored mip level; generated mip levels are derived');
  const { x, y, z = 0 } = region.origin;
  const { width, height, depthOrArrayLayers: depth = 1 } = region.size;
  if (
    ![x, y, z, width, height, depth].every(Number.isSafeInteger) ||
    x < 0 ||
    y < 0 ||
    z < 0 ||
    width <= 0 ||
    height <= 0 ||
    depth <= 0 ||
    x + width > level.width ||
    y + height > level.height ||
    z + depth > level.imagesPerMip
  )
    return invalid('a positive integer region inside the selected mip');
  if (depth > limits.maxRanges)
    return err(
      new AssetError({
        code: 'asset-budget-exceeded',
        expected: 'texture slices within the range budget',
        hint: 'write fewer slices per operation or configure a larger asset range budget',
      }),
    );
  const block = textureFormatBlock(texture.format);
  if (
    x % block.blockWidth !== 0 ||
    y % block.blockHeight !== 0 ||
    (width % block.blockWidth !== 0 && x + width !== level.width) ||
    (height % block.blockHeight !== 0 && y + height !== level.height)
  )
    return invalid('whole compressed blocks, including partial blocks at the image edge');
  const rowBytes = Math.ceil(width / block.blockWidth) * block.bytesPerBlock;
  const rows = Math.ceil(height / block.blockHeight);
  const imageBytes = rowBytes * rows;
  if (region.data.byteLength !== imageBytes * depth)
    return invalid('exactly the tightly packed bytes for this region');
  // Source regions are private captures. Each write visits only its own rows.
  const writes = [];
  for (let image = 0; image < depth; image++)
    writes.push({
      path: ['data'],
      byteOffset:
        level.byteOffset +
        (z + image) * level.bytesPerRow * level.rowsPerImage +
        (y / block.blockHeight) * level.bytesPerRow +
        (x / block.blockWidth) * block.bytesPerBlock,
      bytes: region.data.subarray(image * imageBytes, (image + 1) * imageBytes),
      rowBytes,
      byteStride: level.bytesPerRow,
    });
  return ok({ writes });
}
