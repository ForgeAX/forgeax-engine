import type { EquirectAsset, TextureAsset } from '@forgeax/engine-types';
import { Color, DataUtils, RGBAFormat, type Texture } from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';
import { projectTextureUpload, textureUploadPending } from './texture';

/** Source radiance projection. Native Skylight owns all cube conversion and IBL filtering. */
export function projectEnvironment(texture: Texture, previous?: EquirectAsset): EquirectAsset {
  if (texture.format !== RGBAFormat)
    return unsupported('Environment requires RGBA radiance storage', texture.uuid).unwrap();
  if (previous !== undefined && textureUploadPending(texture)) return previous;
  const image = projectTextureUpload(texture, undefined, texture.flipY, 'environment').unwrap();
  return scaleEnvironment({ ...image, ...image.shape.extent }, 1);
}

/** Background intensity uses the admitted radiance, never unmarked source edits. */
export function scaleEnvironment(
  image: Pick<TextureAsset, 'format' | 'colorSpace'> &
    Pick<EquirectAsset, 'width' | 'height' | 'data'>,
  intensity: number,
): EquirectAsset {
  if (!Number.isFinite(intensity) || intensity < 0)
    return invalid('Scene.backgroundIntensity').unwrap();
  const { width, height } = image;
  if (
    intensity === 1 &&
    image.colorSpace === 'linear' &&
    (image.format === 'rgba16float' || image.format === 'rgba32float')
  )
    return {
      kind: 'equirect',
      width,
      height,
      format: image.format,
      colorSpace: image.colorSpace,
      data: image.data,
    };
  // SkyboxBackground has no intensity uniform. A purpose-specific radiance asset
  // preserves the source and the independently shared lighting image.
  const output = new Uint16Array(width * height * 4);
  const source = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const pixel = new Color();
  const lane = (index: number) =>
    image.format === 'rgba16float'
      ? DataUtils.fromHalfFloat(source.getUint16(index * 2, true))
      : image.format === 'rgba32float'
        ? source.getFloat32(index * 4, true)
        : source.getUint8(index) / 255;
  for (let offset = 0; offset < output.length; offset += 4) {
    pixel.setRGB(lane(offset), lane(offset + 1), lane(offset + 2));
    if (image.colorSpace === 'srgb') pixel.convertSRGBToLinear();
    const values = [pixel.r * intensity, pixel.g * intensity, pixel.b * intensity, 1];
    for (let channel = 0; channel < 4; channel++) {
      const value = values[channel] ?? 0;
      if (!Number.isFinite(value) || Math.abs(value) > 65504)
        return unsupported('Scaled background exceeds native half-float radiance storage').unwrap();
      output[offset + channel] = DataUtils.toHalfFloat(value);
    }
  }
  return {
    kind: 'equirect',
    width,
    height,
    format: 'rgba16float',
    colorSpace: 'linear',
    data: new Uint8Array(output.buffer),
  };
}
