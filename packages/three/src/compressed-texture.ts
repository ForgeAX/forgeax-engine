import { deriveTextureLayout, type TextureAsset } from '@forgeax/engine-types';
import * as THREE from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';

const formats: Readonly<Record<number, GPUTextureFormat>> = {
  [THREE.RGB_S3TC_DXT1_Format]: 'bc1-rgba-unorm',
  [THREE.RGBA_S3TC_DXT1_Format]: 'bc1-rgba-unorm',
  [THREE.RGBA_S3TC_DXT3_Format]: 'bc2-rgba-unorm',
  [THREE.RGBA_S3TC_DXT5_Format]: 'bc3-rgba-unorm',
  [THREE.RED_RGTC1_Format]: 'bc4-r-unorm',
  [THREE.SIGNED_RED_RGTC1_Format]: 'bc4-r-snorm',
  [THREE.RED_GREEN_RGTC2_Format]: 'bc5-rg-unorm',
  [THREE.SIGNED_RED_GREEN_RGTC2_Format]: 'bc5-rg-snorm',
  [THREE.RGBA_BPTC_Format]: 'bc7-rgba-unorm',
  [THREE.RGB_BPTC_UNSIGNED_Format]: 'bc6h-rgb-ufloat',
  [THREE.RGB_BPTC_SIGNED_Format]: 'bc6h-rgb-float',
  [THREE.RGB_ETC1_Format]: 'etc2-rgb8unorm',
  [THREE.RGB_ETC2_Format]: 'etc2-rgb8unorm',
  [THREE.RGBA_ETC2_EAC_Format]: 'etc2-rgba8unorm',
  [THREE.R11_EAC_Format]: 'eac-r11unorm',
  [THREE.SIGNED_R11_EAC_Format]: 'eac-r11snorm',
  [THREE.RG11_EAC_Format]: 'eac-rg11unorm',
  [THREE.SIGNED_RG11_EAC_Format]: 'eac-rg11snorm',
  [THREE.RGBA_ASTC_4x4_Format]: 'astc-4x4-unorm',
  [THREE.RGBA_ASTC_5x4_Format]: 'astc-5x4-unorm',
  [THREE.RGBA_ASTC_5x5_Format]: 'astc-5x5-unorm',
  [THREE.RGBA_ASTC_6x5_Format]: 'astc-6x5-unorm',
  [THREE.RGBA_ASTC_6x6_Format]: 'astc-6x6-unorm',
  [THREE.RGBA_ASTC_8x5_Format]: 'astc-8x5-unorm',
  [THREE.RGBA_ASTC_8x6_Format]: 'astc-8x6-unorm',
  [THREE.RGBA_ASTC_8x8_Format]: 'astc-8x8-unorm',
  [THREE.RGBA_ASTC_10x5_Format]: 'astc-10x5-unorm',
  [THREE.RGBA_ASTC_10x6_Format]: 'astc-10x6-unorm',
  [THREE.RGBA_ASTC_10x8_Format]: 'astc-10x8-unorm',
  [THREE.RGBA_ASTC_10x10_Format]: 'astc-10x10-unorm',
  [THREE.RGBA_ASTC_12x10_Format]: 'astc-12x10-unorm',
  [THREE.RGBA_ASTC_12x12_Format]: 'astc-12x12-unorm',
};

/** Native block storage for both allocation-only and populated compressed images. */
export function compressedTextureFormat(texture: THREE.CompressedTexture): GPUTextureFormat {
  let format = formats[texture.format];
  if (format === undefined) return unsupported('CompressedTexture format', texture.uuid).unwrap();
  if (
    texture.colorSpace === THREE.SRGBColorSpace &&
    !format.startsWith('bc4') &&
    !format.startsWith('bc5') &&
    !format.startsWith('bc6') &&
    !format.startsWith('eac')
  )
    format = `${format}-srgb` as GPUTextureFormat;
  return format;
}

/** Packed blocks stay compressed; native admission checks actual device format support. */
export function projectCompressedTexture(texture: THREE.CompressedTexture): TextureAsset {
  const format = compressedTextureFormat(texture);
  if (texture.flipY)
    return unsupported(
      'CompressedTexture flipY needs native compressed-image flip support',
      texture.uuid,
    ).unwrap();
  const shape = {
    viewDimension: '2d' as const,
    extent: { width: texture.image.width, height: texture.image.height },
  };
  const mips = { kind: 'packed' as const, levelCount: texture.mipmaps.length };
  const layout = deriveTextureLayout({ shape, format, mips }).unwrap();
  const data = new Uint8Array(layout.byteLength);
  for (let index = 0; index < texture.mipmaps.length; index++) {
    const mip = texture.mipmaps[index] as { width: number; height: number; data: Uint8Array },
      level = layout.levels[index];
    if (
      level === undefined ||
      mip.width !== level.width ||
      mip.height !== level.height ||
      !ArrayBuffer.isView(mip.data) ||
      mip.data.byteLength !== level.byteLength
    )
      return invalid('CompressedTexture mip extent/byte length', texture.uuid).unwrap();
    data.set(
      new Uint8Array(mip.data.buffer, mip.data.byteOffset, mip.data.byteLength),
      level.byteOffset,
    );
  }
  return {
    kind: 'texture',
    shape,
    format,
    mips,
    colorSpace: format.endsWith('-srgb') ? 'srgb' : 'linear',
    data,
  };
}
