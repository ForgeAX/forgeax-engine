import { textureFormatBlock } from '@forgeax/engine-types';

/** Native specialization shared by consumers of the full v2 normal surface. */
export const STANDARD_GBUFFER_V2_PIPELINE_CONSTANTS = Object.freeze({ '64003': 1 });
export const STANDARD_GBUFFER_COMPACT_PIPELINE_CONSTANTS = Object.freeze({ '64003': 2 });

/** Enables the split only on the Deferred PSO with an additive diffuse target. */
export const STANDARD_DEFERRED_SUBSURFACE_CONSTANTS = Object.freeze({ '64004': 1 });

export const DEFERRED_COLOR_FORMATS = [
  'rgba16float',
  'rg32uint',
  'r32uint',
  'r32uint',
  'r32uint',
  'rg32uint',
] as const satisfies readonly GPUTextureFormat[];

export const COMPACT_DEFERRED_COLOR_FORMATS = [
  'rgba16float',
  'r32uint',
  'r32uint',
  'r32uint',
  'r32uint',
] as const satisfies readonly GPUTextureFormat[];

export const STANDARD_TEMPORAL_FORMAT = 'rgba16float' as const;
export const STANDARD_VISIBLE_SURFACE_FORMAT = 'rgba32uint' as const;

// The active subsurface lane retains every ordinary receiver attachment.
export const SUBSURFACE_DEFERRED_COLOR_FORMATS = [
  DEFERRED_COLOR_FORMATS[0],
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
export const COMPACT_DEFERRED_ATTACHMENT_BYTES = attachmentBytes(COMPACT_DEFERRED_COLOR_FORMATS);
