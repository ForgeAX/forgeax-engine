import {
  deriveTextureLayout,
  numMipLevels,
  ok,
  type ResolvedMaterialTextureCoordinates,
  type Result,
  type SamplerAsset,
  type TextureAsset,
  type TextureError,
  textureFormatBlock,
} from '@forgeax/engine-types';
import {
  ClampToEdgeWrapping,
  CompressedTexture,
  CubeTexture,
  Data3DTexture,
  DataArrayTexture,
  DataTexture,
  DepthTexture,
  EquirectangularReflectionMapping,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearMipmapNearestFilter,
  LinearSRGBColorSpace,
  MirroredRepeatWrapping,
  NearestFilter,
  NearestMipmapLinearFilter,
  NearestMipmapNearestFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  RGFormat,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  UVMapping,
} from 'three/src/Three.Core.js';
import { compressedTextureFormat, projectCompressedTexture } from './compressed-texture';
import { invalid, unsupported } from './errors';

/** Project only matrices expressible by the existing native offset/rotation/scale contract. */
export function textureCoordinates(
  texture: Texture,
): Result<ResolvedMaterialTextureCoordinates, Error> {
  if (texture.matrixAutoUpdate) texture.updateMatrix();
  const [a, b, p, c, d, q, x, y, w] = texture.matrix.elements;
  if (!texture.matrix.elements.every((value) => Number.isFinite(Math.fround(value))))
    return invalid('Texture UV transform values', texture.uuid);
  if (p !== 0 || q !== 0 || w !== 1)
    return unsupported('Texture UV transform requires affine coordinates', texture.uuid);
  const scaleX = Math.hypot(a, b),
    columnY = Math.hypot(c, d);
  // Native R*S has orthogonal columns. Three S*R can introduce shear; never
  // approximate that matrix by dropping its shear or baking the shared image.
  if (
    scaleX !== 0 &&
    columnY !== 0 &&
    Math.abs((a / scaleX) * (c / columnY) + (b / scaleX) * (d / columnY)) > 1e-10
  )
    return unsupported(
      'Texture UV transform requires native affine support for shear',
      texture.uuid,
    );
  const rotation = (scaleX !== 0 ? Math.atan2(b, a) : Math.atan2(-c, d)) || 0;
  const scaleY = -Math.sin(rotation) * c + Math.cos(rotation) * d;
  if (![scaleX, scaleY].every((value) => Number.isFinite(Math.fround(value))))
    return invalid('Texture UV transform scale', texture.uuid);
  return ok({
    set: texture.channel,
    transform: { offset: [x, y], scale: [scaleX, scaleY], rotation },
  });
}

export function textureValues(texture: Texture): unknown[] {
  // r184 Textures.updateTexture admits an image only when this version changes.
  // Image assignment and Source.dataReady alone never publish a GPU update.
  return [texture.version];
}

export function textureUploadPending(texture: Texture): boolean {
  const image = texture.image as { complete?: boolean } | null | undefined;
  return (
    texture.version === 0 || image == null || image.complete === false || !texture.source.dataReady
  );
}

/** Preserve Three's loading state through ordinary native asset publications. */
export function projectTextureUpload(
  texture: Texture,
  previous: TextureAsset | undefined,
  flipY = texture.flipY,
  usage: 'surface' | 'environment' = 'surface',
): Result<TextureAsset, Error | TextureError> {
  const valid = validateTexture(texture, usage);
  if (!valid.ok) return valid;
  if (!textureUploadPending(texture)) return projectTexture(texture, flipY, usage);
  if (previous !== undefined) return ok(previous);
  const image = texture.image as { width?: number; height?: number } | null | undefined;
  const allocate = texture.version > 0 && !texture.source.dataReady && image != null;
  const channels = texture.format === RGBAFormat ? 4 : texture.format === RGFormat ? 2 : 1;
  const format =
    texture instanceof CompressedTexture && Number(texture.format) !== RGBAFormat
      ? compressedTextureFormat(texture)
      : textureStorageFormat(texture, channels);
  const block = textureFormatBlock(format);
  const width = allocate ? (image.width ?? 0) : block.blockWidth;
  const height = allocate ? (image.height ?? 0) : block.blockHeight;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    return invalid('Texture image extent', texture.uuid);
  const shape = { viewDimension: '2d' as const, extent: { width, height } };
  const mips = { kind: 'none' as const };
  const layout = deriveTextureLayout({ shape, format, mips });
  if (!layout.ok) return layout;
  // WebGPU initializes Three's default/allocation-only textures to zero.
  // Keep the format: a single-channel texture still samples alpha as one.
  return ok({
    kind: 'texture',
    shape,
    format,
    colorSpace: texture.colorSpace === SRGBColorSpace ? 'srgb' : 'linear',
    mips,
    data: new Uint8Array(layout.value.byteLength),
  });
}

export function samplerValues(texture: Texture): unknown[] {
  return [
    texture.magFilter,
    texture.minFilter,
    texture.wrapS,
    texture.wrapT,
    texture.anisotropy,
    texture.generateMipmaps,
    texture.mipmaps.length,
  ];
}

export function validateTexture(
  texture: Texture,
  usage: 'surface' | 'environment' = 'surface',
): Result<void, Error> {
  if (
    texture.mapping !== (usage === 'environment' ? EquirectangularReflectionMapping : UVMapping) ||
    (!(texture instanceof CompressedTexture) &&
      (![RedFormat, RGFormat, RGBAFormat].some((format) => texture.format === format) ||
        ![UnsignedByteType, HalfFloatType, FloatType].some((type) => texture.type === type)))
  )
    return unsupported('Texture mapping/format/type/premultiplyAlpha', texture.uuid);
  if (
    texture.isRenderTargetTexture ||
    texture instanceof CubeTexture ||
    texture instanceof Data3DTexture ||
    texture instanceof DataArrayTexture ||
    texture instanceof DepthTexture
  )
    return unsupported('Texture shape/source kind', texture.uuid);
  if (!Number.isInteger(texture.channel) || texture.channel < 0 || texture.channel > 3)
    return unsupported('Texture.channel outside r184 UV0-UV3', texture.uuid);
  if (![1, 2, 4, 8].includes(texture.unpackAlignment))
    return invalid('Texture.unpackAlignment', texture.uuid);
  if (texture.type !== UnsignedByteType && !(texture instanceof DataTexture))
    return unsupported('Float image sources require DataTexture', texture.uuid);
  if (
    !(texture instanceof CompressedTexture) &&
    texture.colorSpace === SRGBColorSpace &&
    (texture.format !== RGBAFormat || texture.type !== UnsignedByteType)
  )
    return unsupported('sRGB requires RGBA unsigned-byte texture storage', texture.uuid);
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
  usage: 'surface' | 'environment' = 'surface',
): Result<TextureAsset, Error | TextureError> {
  const valid = validateTexture(texture, usage);
  if (!valid.ok) return valid;
  if (texture instanceof CompressedTexture) return ok(projectCompressedTexture(texture));
  const channels = texture.format === RGBAFormat ? 4 : texture.format === RGFormat ? 2 : 1;
  const srgb = texture.colorSpace === SRGBColorSpace;
  const format = textureStorageFormat(texture, channels);
  const images: readonly unknown[] = texture.mipmaps.length > 0 ? texture.mipmaps : [texture.image];
  const base = readImage(texture, images[0], channels, flipY);
  if (!base.ok) return base;
  const { width, height } = base.value;
  if (images.length > numMipLevels({ width, height }))
    return invalid('Texture mip count', texture.uuid);
  const shape = { viewDimension: '2d' as const, extent: { width, height } };
  const mips: TextureAsset['mips'] =
    texture.mipmaps.length > 0
      ? { kind: 'packed', levelCount: images.length }
      : { kind: texture.generateMipmaps ? 'generate' : 'none' };
  const layout = deriveTextureLayout({ shape, format, mips });
  if (!layout.ok) return layout;
  const data = images.length === 1 ? base.value.data : new Uint8Array(layout.value.byteLength);
  for (let level = 0; level < images.length; level++) {
    const image = level === 0 ? base : readImage(texture, images[level], channels, flipY);
    if (!image.ok) return image;
    const target = layout.value.levels[level];
    if (
      target === undefined ||
      image.value.width !== target.width ||
      image.value.height !== target.height
    )
      return invalid('Texture mip extent', texture.uuid);
    data.set(image.value.data, target.byteOffset);
  }
  return ok({ kind: 'texture', shape, format, colorSpace: srgb ? 'srgb' : 'linear', mips, data });
}

function textureStorageFormat(texture: Texture, channels: number): GPUTextureFormat {
  return texture.type === FloatType
    ? channels === 4
      ? 'rgba32float'
      : channels === 2
        ? 'rg32float'
        : 'r32float'
    : texture.type === HalfFloatType
      ? channels === 4
        ? 'rgba16float'
        : channels === 2
          ? 'rg16float'
          : 'r16float'
      : channels === 4
        ? texture.colorSpace === SRGBColorSpace
          ? 'rgba8unorm-srgb'
          : 'rgba8unorm'
        : channels === 2
          ? 'rg8unorm'
          : 'r8unorm';
}

function readImage(
  texture: Texture,
  image: unknown,
  channels: number,
  flipY: boolean,
): Result<{ width: number; height: number; data: Uint8Array }, Error> {
  if (typeof image !== 'object' || image === null)
    return unsupported('Texture image not loaded; await TextureLoader.loadAsync()', texture.uuid);
  const dimensions = image as {
    width?: number;
    height?: number;
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    data?: unknown;
  };
  const width = dimensions.videoWidth ?? dimensions.naturalWidth ?? dimensions.width ?? 0;
  const height = dimensions.videoHeight ?? dimensions.naturalHeight ?? dimensions.height ?? 0;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    return invalid('Texture image extent', texture.uuid);
  const bytesPerPixel =
    channels * (texture.type === HalfFloatType ? 2 : texture.type === FloatType ? 4 : 1);
  const row = width * bytesPerPixel;
  const pixels = new Uint8Array(row * height);
  if (dimensions.data !== undefined) {
    const source = dimensions.data;
    if (
      texture.type === FloatType
        ? !(source instanceof Float32Array)
        : texture.type === HalfFloatType
          ? !(source instanceof Uint16Array)
          : !(source instanceof Uint8Array || source instanceof Uint8ClampedArray)
    )
      return invalid('DataTexture storage', texture.uuid);
    const view = source as Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
    const stride = row;
    if (view.byteLength < stride * (height - 1) + row)
      return invalid('DataTexture byte length', texture.uuid);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let y = 0; y < height; y++)
      pixels.set(bytes.subarray(y * stride, y * stride + row), (flipY ? height - 1 - y : y) * row);
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
      const rgba = context.getImageData(0, 0, width, height).data;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const target = ((flipY ? height - 1 - y : y) * width + x) * channels;
          for (let channel = 0; channel < channels; channel++)
            pixels[target + channel] = Math.round(
              (rgba[(y * width + x) * 4 + channel] ?? 0) *
                (texture.premultiplyAlpha && channel < 3
                  ? (rgba[(y * width + x) * 4 + 3] ?? 255) / 255
                  : 1),
            );
        }
      }
    } catch {
      return unsupported(
        'Texture image read; check CORS and decoded image readiness',
        texture.uuid,
      );
    }
  }
  return ok({ width, height, data: pixels });
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
  if (!Number.isInteger(texture.anisotropy) || texture.anisotropy < 1)
    return invalid('Texture.anisotropy', texture.uuid);
  const filter = [NearestFilter, NearestMipmapNearestFilter, NearestMipmapLinearFilter].some(
    (value) => value === min,
  )
    ? ('nearest' as const)
    : ('linear' as const);
  // r184 WebGPU converts the minification constant once for both filter modes.
  const anisotropy =
    texture.magFilter === LinearFilter && filter === 'linear' ? texture.anisotropy : 1;
  if (anisotropy > 16) return invalid('Texture.anisotropy exceeds WebGPU maximum 16', texture.uuid);
  return ok({
    kind: 'sampler',
    addressModeU: u,
    addressModeV: v,
    magFilter: texture.magFilter === NearestFilter ? 'nearest' : 'linear',
    minFilter: filter,
    mipmapFilter: filter,
    ...(anisotropy > 1 ? { maxAnisotropy: anisotropy } : {}),
  });
}
