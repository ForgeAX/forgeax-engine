import {
  err,
  ok,
  type Result,
  type RhiDevice,
  type RhiError,
  type Texture,
} from '@forgeax/engine-rhi';
import {
  AssetError,
  type DecodedImage,
  deriveTextureLayout,
  type TextureAsset,
} from '@forgeax/engine-types';

/**
 * Upload an offline-baked mip chain. Each
 * level uses its own block-padded bytesPerRow / rowsPerImage and mip-major
 * byte offset (deriveTextureLayout, SSOT block math); full-subresource copies
 * keep their logical size for non-block-aligned dimensions. writeTexture
 * avoids the 256 B copyBufferToTexture row-alignment trap.
 */
export function writePackedTextureLevels(
  device: Pick<RhiDevice, 'queue'>,
  texture: Texture,
  tex: TextureAsset,
  format: GPUTextureFormat,
  bytes: Uint8Array,
): Result<void, AssetError | RhiError> {
  const layout = deriveTextureLayout({ shape: tex.shape, format, mips: tex.mips });
  if (!layout.ok) {
    return err(
      new AssetError({
        code: 'invalid-source-format',
        expected: layout.error.expected,
        hint: layout.error.hint,
      }),
    );
  }
  for (const level of layout.value.levels) {
    for (let image = 0; image < level.imagesPerMip; image++) {
      const imageBytes = level.bytesPerRow * level.rowsPerImage;
      const offset = level.byteOffset + image * imageBytes;
      const writeRes = device.queue.writeTexture(
        { texture, mipLevel: level.level, origin: { x: 0, y: 0, z: image } },
        bytes.subarray(offset, offset + imageBytes),
        { offset: 0, bytesPerRow: level.bytesPerRow, rowsPerImage: level.rowsPerImage },
        { width: level.physicalWidth, height: level.physicalHeight, depthOrArrayLayers: 1 },
      );
      if (!writeRes.ok) return writeRes;
    }
  }
  return ok(undefined);
}

/**
 * Synthesize the `DecodedImage` view the texture-upload prelude consumes from
 * a `TextureAsset` POD (the record-stage pull path holds only the POD). The
 * POD's `data` is the pixel bytes; `colorSpace` + `mips` drive the
 * consistency assertion + mip count.
 */
export function decodedFromTexture(tex: TextureAsset): DecodedImage {
  return {
    bytes: tex.data,
    width: tex.shape.extent.width,
    height: tex.shape.extent.height,
    mime: 'image/png',
    colorSpace: tex.colorSpace,
    mipmap: tex.mips.kind === 'generate',
  };
}
