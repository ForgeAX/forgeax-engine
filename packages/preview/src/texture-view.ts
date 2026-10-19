import {
  deriveTextureLayout,
  type EquirectAsset,
  type MaterialAsset,
  type TextureAsset,
} from '@forgeax/engine-types';

/** Shared by the build-time shader contract and the preview's runtime material. */
export function createTextureViewMaterial(
  dimension: TextureAsset['shape']['viewDimension'],
): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: {
          module: `texture_preview::texture_${dimension.replaceAll('-', '_')}`,
          vertexEntry: 'vs_main',
          fragmentEntry: 'fs_main',
        },
        renderState: {
          cullMode: 'none',
          depthWriteEnabled: false,
          tags: { LightMode: 'Forward' },
        },
      },
    ],
    parameters: [
      ...['channels', 'display', 'presentation', 'panRotation', 'background'].map((name) => ({
        name,
        type: 'vec4' as const,
      })),
      {
        name: 'sourceTexture',
        type:
          dimension === '2d'
            ? 'texture'
            : dimension === '2d-array'
              ? 'texture_2d_array'
              : 'texture_3d',
        sampleType: 'unfilterable-float',
      },
    ],
  };
}

export interface TextureViewOptions {
  readonly channels: readonly [boolean, boolean, boolean, boolean];
  readonly mip: number;
  readonly layer: number;
  readonly projection: 'flat' | 'environment' | 'cross' | 'face';
  readonly face: number;
  readonly exposure: number;
  readonly filter: 'nearest' | 'linear';
  readonly background: 'checker' | 'black' | 'white' | 'transparent';
  readonly desaturate: boolean;
  readonly zoom: 'fit' | number;
  readonly pan: readonly [number, number];
  readonly rotation: readonly [number, number];
}

export interface TextureViewInfo {
  readonly kind: 'texture' | 'equirect';
  readonly dimension: TextureAsset['shape']['viewDimension'];
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly format: GPUTextureFormat;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mipCount: number;
  readonly sourceBytes: number;
  readonly options: TextureViewOptions;
}

export interface TextureViewControl {
  readonly get: () => TextureViewInfo | Promise<TextureViewInfo>;
  readonly set: (options: unknown) => TextureViewInfo | Promise<TextureViewInfo>;
}

export function textureViewSource(asset: TextureAsset | EquirectAsset): TextureAsset {
  if (asset.kind === 'texture') return asset;
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: asset.width, height: asset.height } },
    format: asset.format,
    data: new Uint8Array(asset.data.buffer, asset.data.byteOffset, asset.data.byteLength),
    colorSpace: asset.colorSpace,
    mips: { kind: 'none' },
  };
}

export function describeTextureView(asset: TextureAsset | EquirectAsset): TextureViewInfo {
  const source = textureViewSource(asset);
  if (
    /(?:uint|sint)$/.test(source.format) ||
    source.format.startsWith('depth') ||
    source.format === 'stencil8'
  ) {
    throw new TypeError(
      'Texture inspection requires a float-sampled color format; integer and depth/stencil sources are not supported',
    );
  }
  const layout = deriveTextureLayout({
    ...source,
    actualByteLength: source.data.byteLength,
  }).unwrap();
  return {
    kind: asset.kind,
    dimension: source.shape.viewDimension,
    width: source.shape.extent.width,
    height: source.shape.extent.height,
    depth:
      source.shape.viewDimension === '2d'
        ? 1
        : source.shape.viewDimension === '3d'
          ? source.shape.extent.depth
          : source.shape.extent.layers,
    format: source.format,
    colorSpace: source.colorSpace,
    mipCount: layout.levels.length,
    sourceBytes: source.data.byteLength,
    options: {
      channels: [true, true, true, true],
      mip: 0,
      layer: 0,
      projection: asset.kind === 'equirect' ? 'environment' : 'flat',
      face: 0,
      exposure: 0,
      filter: 'linear',
      background: 'checker',
      desaturate: false,
      zoom: 'fit',
      pan: [0, 0],
      rotation: [0, 0],
    },
  };
}

export function validateTextureViewOptions(
  info: TextureViewInfo,
  input: unknown,
): TextureViewOptions {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Texture view options must be an object');
  const patch = input as Record<string, unknown>;
  for (const key of Object.keys(patch))
    if (!Object.hasOwn(info.options, key))
      throw new TypeError(`Unknown texture view option: ${key}`);
  const value = { ...info.options, ...patch } as TextureViewOptions;
  const finite = (n: unknown, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  const integer = (n: unknown, min: number, max: number) =>
    finite(n, min, max) && Number.isInteger(n);
  const pair = (v: unknown, min: number, max: number) =>
    Array.isArray(v) && v.length === 2 && v.every((n) => finite(n, min, max));
  const layers = info.dimension === '3d' ? Math.max(1, info.depth >> value.mip) : info.depth;
  if (
    !Array.isArray(value.channels) ||
    value.channels.length !== 4 ||
    !value.channels.every((v) => typeof v === 'boolean') ||
    !integer(value.mip, 0, info.mipCount - 1) ||
    !integer(value.layer, 0, layers - 1) ||
    !['flat', 'environment', 'cross', 'face'].includes(value.projection) ||
    (info.kind !== 'equirect' && value.projection !== 'flat') ||
    !integer(value.face, 0, 5) ||
    !finite(value.exposure, -16, 16) ||
    !['nearest', 'linear'].includes(value.filter) ||
    !['checker', 'black', 'white', 'transparent'].includes(value.background) ||
    typeof value.desaturate !== 'boolean' ||
    (value.zoom !== 'fit' && !finite(value.zoom, 0.03125, 1024)) ||
    !pair(value.pan, -1000000, 1000000) ||
    !pair(value.rotation, -36000, 36000)
  ) {
    throw new TypeError(
      'Texture view options exceed the bound texture dimensions or supported display modes',
    );
  }
  return structuredClone(value);
}
