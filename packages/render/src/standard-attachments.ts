import { textureFormatBlock } from '@forgeax/engine-types';

export const DEFERRED_COLOR_FORMATS = [
  'rgba16float',
  'r32uint',
  'r32uint',
  'r32uint',
  'r32uint',
  'rg32uint',
] as const satisfies readonly GPUTextureFormat[];

export const STANDARD_TEMPORAL_FORMAT = 'rgba16float' as const;
export const STANDARD_VISIBLE_SURFACE_FORMAT = 'rgba32uint' as const;

// The active subsurface lane retains every ordinary receiver attachment.
export const SUBSURFACE_DEFERRED_COLOR_FORMATS = [
  'rgba32float',
  DEFERRED_COLOR_FORMATS[1],
  DEFERRED_COLOR_FORMATS[2],
  DEFERRED_COLOR_FORMATS[3],
  'rg32uint',
  DEFERRED_COLOR_FORMATS[5],
] as const satisfies readonly GPUTextureFormat[];

function attachmentBytes(formats: readonly GPUTextureFormat[]) {
  const surface = formats.reduce(
    (bytes, format) => bytes + textureFormatBlock(format).bytesPerBlock,
    0,
  );
  const temporal = textureFormatBlock(STANDARD_TEMPORAL_FORMAT).bytesPerBlock;
  const visibleSurface = textureFormatBlock(STANDARD_VISIBLE_SURFACE_FORMAT).bytesPerBlock;
  return {
    surface,
    temporal: surface + temporal,
    visibleSurface: surface + visibleSurface,
    visibleSurfaceTemporal: surface + visibleSurface + temporal,
  } as const;
}

// Format blocks own graph targets, device requests and temporal MRT admission.
export const DEFERRED_ATTACHMENT_BYTES = attachmentBytes(DEFERRED_COLOR_FORMATS);
export const SUBSURFACE_ATTACHMENT_BYTES = attachmentBytes(SUBSURFACE_DEFERRED_COLOR_FORMATS);
