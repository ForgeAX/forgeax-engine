import { ok, type Result, type SamplerAsset, type TextureAsset } from '@forgeax/engine-types';
import {
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearMipmapNearestFilter,
  LinearSRGBColorSpace,
  MirroredRepeatWrapping,
  NearestFilter,
  NearestMipmapLinearFilter,
  NearestMipmapNearestFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  UVMapping,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';

export function textureValues(texture: Texture): unknown[] {
  return [
    texture.version,
    texture.source,
    texture.source.version,
    texture.image,
    texture.colorSpace,
    texture.flipY,
    texture.generateMipmaps,
    texture.format,
    texture.type,
    texture.premultiplyAlpha,
  ];
}

export function samplerValues(texture: Texture): unknown[] {
  return [
    texture.magFilter,
    texture.minFilter,
    texture.wrapS,
    texture.wrapT,
    texture.anisotropy,
    texture.generateMipmaps,
  ];
}

export function validateTexture(texture: Texture): Result<void, Error> {
  if (
    texture.mapping !== UVMapping ||
    texture.channel !== 0 ||
    texture.mipmaps.length > 0 ||
    texture.premultiplyAlpha ||
    texture.format !== RGBAFormat ||
    texture.type !== UnsignedByteType
  )
    return unsupported(
      'Texture mapping/channel/mipmaps/format/type/premultiplyAlpha',
      texture.uuid,
    );
  if (
    !texture.matrixAutoUpdate ||
    texture.offset.x !== 0 ||
    texture.offset.y !== 0 ||
    texture.repeat.x !== 1 ||
    texture.repeat.y !== 1 ||
    texture.rotation !== 0 ||
    texture.center.x !== 0 ||
    texture.center.y !== 0
  )
    return unsupported('Texture UV transform', texture.uuid);
  if (
    ![NoColorSpace, LinearSRGBColorSpace, SRGBColorSpace].some(
      (value) => value === texture.colorSpace,
    )
  )
    return unsupported('Texture.colorSpace', texture.uuid);
  return ok(undefined);
}

export function projectTexture(
  texture: Texture,
  flipY = texture.flipY,
): Result<TextureAsset, Error> {
  const valid = validateTexture(texture);
  if (!valid.ok) return valid;
  const image: unknown = texture.image;
  if (typeof image !== 'object' || image === null)
    return unsupported('Texture image not loaded; await TextureLoader.loadAsync()', texture.uuid);
  const dimensions = image as {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    data?: unknown;
  };
  const width = dimensions.naturalWidth ?? dimensions.width ?? 0;
  const height = dimensions.naturalHeight ?? dimensions.height ?? 0;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    return invalid('Texture image extent', texture.uuid);
  let pixels: Uint8Array;
  if (dimensions.data !== undefined) {
    if (
      !(dimensions.data instanceof Uint8Array || dimensions.data instanceof Uint8ClampedArray) ||
      dimensions.data.length !== width * height * 4
    )
      return invalid('DataTexture RGBA byte length', texture.uuid);
    pixels = new Uint8Array(dimensions.data);
  } else {
    if (typeof document === 'undefined')
      return unsupported('image texture requires a browser or RGBA DataTexture', texture.uuid);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (context === null)
      return unsupported('CanvasRenderingContext2D for image decode', texture.uuid);
    try {
      context.drawImage(image as CanvasImageSource, 0, 0, width, height);
      pixels = new Uint8Array(context.getImageData(0, 0, width, height).data);
    } catch {
      return unsupported(
        'Texture image read; check CORS and decoded image readiness',
        texture.uuid,
      );
    }
  }
  if (flipY) {
    const row = width * 4;
    const flipped = new Uint8Array(pixels.length);
    for (let y = 0; y < height; y++)
      flipped.set(pixels.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
    pixels = flipped;
  }
  const srgb = texture.colorSpace === SRGBColorSpace;
  return ok({
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
    colorSpace: srgb ? 'srgb' : 'linear',
    mips: { kind: texture.generateMipmaps ? 'generate' : 'none' },
    data: pixels,
  });
}

export function projectSampler(texture: Texture): Result<SamplerAsset, Error> {
  const address = (value: number): GPUAddressMode | undefined =>
    value === ClampToEdgeWrapping
      ? 'clamp-to-edge'
      : value === RepeatWrapping
        ? 'repeat'
        : value === MirroredRepeatWrapping
          ? 'mirror-repeat'
          : undefined;
  const min = texture.minFilter;
  if (
    ![
      NearestFilter,
      LinearFilter,
      NearestMipmapNearestFilter,
      NearestMipmapLinearFilter,
      LinearMipmapNearestFilter,
      LinearMipmapLinearFilter,
    ].includes(min)
  )
    return unsupported('Texture.minFilter', texture.uuid);
  const u = address(texture.wrapS),
    v = address(texture.wrapT);
  if (
    u === undefined ||
    v === undefined ||
    ![NearestFilter, LinearFilter].includes(texture.magFilter)
  )
    return unsupported('Texture wrapping/magFilter', texture.uuid);
  if (texture.anisotropy !== 1) return unsupported('Texture.anisotropy', texture.uuid);
  return ok({
    kind: 'sampler',
    addressModeU: u,
    addressModeV: v,
    magFilter: texture.magFilter === NearestFilter ? 'nearest' : 'linear',
    minFilter: [NearestFilter, NearestMipmapNearestFilter, NearestMipmapLinearFilter].some(
      (value) => value === min,
    )
      ? 'nearest'
      : 'linear',
    mipmapFilter: [LinearMipmapLinearFilter, NearestMipmapLinearFilter].some(
      (value) => value === min,
    )
      ? 'linear'
      : 'nearest',
    ...(texture.generateMipmaps && min !== LinearFilter && min !== NearestFilter
      ? {}
      : { lodMaxClamp: 0 }),
  });
}
