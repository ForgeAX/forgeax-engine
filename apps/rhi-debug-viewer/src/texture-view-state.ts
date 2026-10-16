export type TextureZoom = 'fit' | number;
export type TextureAspect = 'all' | 'depth-only' | 'stencil-only';
export type TextureAspectOptions = readonly [TextureAspect, ...TextureAspect[]];

export interface TextureViewState {
  readonly mipLevel: number;
  readonly arrayLayer: number;
  readonly aspect: TextureAspect;
  readonly zoom: TextureZoom;
}

export const DEFAULT_TEXTURE_VIEW_STATE: TextureViewState = {
  mipLevel: 0,
  arrayLayer: 0,
  aspect: 'all',
  zoom: 'fit',
};

/** Return only aspects that the core readback matrix accepts for this texture format. */
export function textureAspectOptions(format: string | null): TextureAspectOptions {
  if (format?.endsWith('-stencil8')) return ['depth-only', 'stencil-only'];
  if (format?.startsWith('depth')) return ['depth-only'];
  return ['all'];
}

export interface TextureDescriptorFacts {
  readonly dimension: string;
  readonly format: string | null;
  readonly width: number;
  readonly height: number;
  readonly arrayLayerCount: number;
  readonly mipLevelCount: number;
}

export function textureDescriptorFacts(descriptor: unknown): TextureDescriptorFacts {
  if (descriptor === null || typeof descriptor !== 'object') return unknownTextureFacts();
  const outer = descriptor as Record<string, unknown>;
  const value =
    outer.desc !== null && typeof outer.desc === 'object'
      ? (outer.desc as Record<string, unknown>)
      : outer;
  const size = value.size;
  const dimensions = Array.isArray(size)
    ? size
    : size !== null && typeof size === 'object'
      ? [
          (size as Record<string, unknown>).width,
          (size as Record<string, unknown>).height,
          (size as Record<string, unknown>).depthOrArrayLayers,
        ]
      : [];
  return {
    dimension: typeof value.dimension === 'string' ? value.dimension : '2d',
    format: typeof value.format === 'string' ? value.format : null,
    width: positiveInteger(dimensions[0], 1),
    height: positiveInteger(dimensions[1], 1),
    arrayLayerCount: positiveInteger(dimensions[2], 1),
    mipLevelCount: positiveInteger(value.mipLevelCount, 1),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function unknownTextureFacts(): TextureDescriptorFacts {
  return {
    dimension: '2d',
    format: null,
    width: 1,
    height: 1,
    arrayLayerCount: 1,
    mipLevelCount: 1,
  };
}
