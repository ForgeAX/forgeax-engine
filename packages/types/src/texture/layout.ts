import { err, ok, type Result } from '../result.js';
import type { TextureMipPolicy, TextureShape } from './asset.js';
import { textureFormatBlock } from './block.js';
import { type TextureError, textureError, validateTextureShape } from './errors.js';

export interface TextureLayoutInput {
  readonly shape: TextureShape;
  readonly format: GPUTextureFormat;
  readonly mips: TextureMipPolicy;
  /** Authored bytes: one base level for generate; the full declared chain for packed. */
  readonly actualByteLength?: number;
  readonly order?: string;
}

export interface TextureMipLayout {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly imagesPerMip: number;
  readonly bytesPerRow: number;
  readonly rowsPerImage: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface TextureLayout {
  readonly shape: TextureShape;
  readonly format: GPUTextureFormat;
  readonly levels: readonly TextureMipLayout[];
  readonly byteLength: number;
}

function mipLevelCount(shape: TextureShape, mips: TextureMipPolicy): number {
  if (mips.kind === 'none') return 1;
  if (mips.kind === 'packed') return mips.levelCount;
  const { width, height } = shape.extent;
  let levels = 1;
  let largest = Math.max(width, height);
  if (shape.viewDimension === '3d') largest = Math.max(largest, shape.extent.depth);
  while (largest > 1) {
    largest = Math.max(1, largest >> 1);
    levels += 1;
  }
  return levels;
}

function imagesPerMip(shape: TextureShape, level: number): number {
  if (shape.viewDimension === '2d') return 1;
  if (shape.viewDimension === '2d-array') return shape.extent.layers;
  return Math.max(1, shape.extent.depth >> level);
}

/** Derive the canonical mip-major, image-major, row-major texture layout. */
export function deriveTextureLayout(
  input: TextureLayoutInput,
): Result<TextureLayout, TextureError> {
  return projectTextureLayout(input, true);
}

/** Validate the canonical layout without retaining unused per-mip records. */
export function validateTextureLayout(input: TextureLayoutInput): Result<void, TextureError> {
  const layout = projectTextureLayout(input, false);
  return layout.ok ? ok(undefined) : layout;
}

function projectTextureLayout(
  input: TextureLayoutInput,
  includeLevels: boolean,
): Result<TextureLayout, TextureError> {
  const shapeResult = validateTextureShape(input.shape, input.mips, input.format);
  if (!shapeResult.ok) return shapeResult;

  if (input.order !== undefined && input.order !== 'mip-major,image-major,row-major') {
    return err(
      textureError(
        'texture-packing-invalid',
        {
          code: 'texture-packing-invalid',
          expectedBytes: 0,
          actualBytes: input.actualByteLength ?? 0,
          order: input.order,
        },
        'texture bytes must use mip-major, image-major, row-major order',
      ),
    );
  }

  const params = textureFormatBlock(input.format);
  const levels: TextureMipLayout[] = [];
  let byteOffset = 0;
  let baseLevelBytes = 0;
  const count = mipLevelCount(input.shape, input.mips);
  for (let level = 0; level < count; level++) {
    const width = Math.max(1, input.shape.extent.width >> level);
    const height = Math.max(1, input.shape.extent.height >> level);
    const blockColumns = Math.ceil(width / params.blockWidth);
    const rowsPerImage = Math.ceil(height / params.blockHeight);
    const bytesPerRow = blockColumns * params.bytesPerBlock;
    const byteLength = bytesPerRow * rowsPerImage * imagesPerMip(input.shape, level);
    // Keep the original field observations even for validation-only callers:
    // compressed-format records and author shape fields may expose getters.
    const physicalWidth = blockColumns * params.blockWidth;
    const physicalHeight = rowsPerImage * params.blockHeight;
    const images = imagesPerMip(input.shape, level);
    if (includeLevels) {
      levels.push({
        level,
        width,
        height,
        physicalWidth,
        physicalHeight,
        imagesPerMip: images,
        bytesPerRow,
        rowsPerImage,
        byteOffset,
        byteLength,
      });
    }
    if (level === 0) baseLevelBytes = byteLength;
    byteOffset += byteLength;
  }

  // Generated levels occupy GPU storage but are not present in the source payload.
  const authoredBytes = input.mips.kind === 'generate' ? baseLevelBytes : byteOffset;
  if (input.actualByteLength !== undefined && input.actualByteLength !== authoredBytes) {
    return err(
      textureError(
        'texture-packing-invalid',
        {
          code: 'texture-packing-invalid',
          expectedBytes: authoredBytes,
          actualBytes: input.actualByteLength,
        },
        'texture data length must equal the derived canonical byte length',
      ),
    );
  }
  return ok({
    shape: input.shape,
    format: input.format,
    levels,
    byteLength: byteOffset,
  });
}
