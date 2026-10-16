import type { RenderError } from '../errors/render';
import {
  RenderTargetCapabilityMissingError,
  RenderTargetDescriptorInvalidError,
} from '../errors/render';
import type { RenderResult } from '../render-contract';

export type RenderTargetFormat = 'rgba16float' | 'rgba8unorm' | 'rgba8unorm-srgb';
/**
 * Closed target storage shapes. `3d` is a volume whose writers select one
 * depth slice; `2d-array` is a layered 2D texture whose writers select one
 * array layer. Both use {@link RenderTargetDescriptor.depthOrArrayLayers}.
 */
export type RenderTargetShape = '2d' | 'cube' | '3d' | '2d-array';
/** Shapes whose layer count is an authored descriptor fact. */
export type RenderTargetLayeredShape = '3d' | '2d-array';
export type RenderTargetMipLevels = 1 | 'full';
export type RenderTargetSampleCount = 1 | 4;
export type RenderTargetDepthFormat =
  | 'depth24plus-stencil8'
  | 'depth32float-stencil8'
  | 'depth32float';

interface RenderTargetDescriptorFacts {
  readonly width: number;
  readonly height: number;
  readonly format: RenderTargetFormat;
  readonly mipLevels: RenderTargetMipLevels;
  readonly sampleCount: RenderTargetSampleCount;
  readonly depth?: RenderTargetDepthFormat;
  readonly sampled: boolean;
  readonly readback: boolean;
}

/**
 * Target descriptor. `2d` has one layer and `cube` six; `3d` and `2d-array`
 * name their depth-slice or array-layer count in `depthOrArrayLayers`.
 */
export type RenderTargetDescriptor =
  | (RenderTargetDescriptorFacts & {
      readonly shape: '2d' | 'cube';
      readonly depthOrArrayLayers?: never;
    })
  | (RenderTargetDescriptorFacts & {
      readonly shape: RenderTargetLayeredShape;
      readonly depthOrArrayLayers: number;
    });

/**
 * Writable layer count: array layers for `2d`/`cube`/`2d-array`, depth slices
 * for `3d`. Writers, readback, and resolution all index `0..count-1`.
 */
export function renderTargetLayerCount(descriptor: RenderTargetDescriptor): number {
  switch (descriptor.shape) {
    case '2d':
      return 1;
    case 'cube':
      return 6;
    case '3d':
    case '2d-array':
      return descriptor.depthOrArrayLayers;
  }
}

declare const RenderTargetBrand: unique symbol;
declare const RenderTargetTextureSourceBrand: unique symbol;
declare const RenderTargetReadbackTicketBrand: unique symbol;

/** Opaque logical target lease owned by one Renderer. */
export interface RenderTarget {
  readonly [RenderTargetBrand]: 'RenderTarget';
}

export type RenderTargetTextureAspect = 'color';

export interface RenderTargetTextureSourceOptions {
  readonly aspect: RenderTargetTextureAspect;
  readonly dimension: RenderTargetShape;
  readonly mipLevel: number;
}

/** Renderer-local runtime material source; it is not an asset handle. */
export interface RenderTargetTextureSource {
  readonly [RenderTargetTextureSourceBrand]: 'RenderTargetTextureSource';
}

export interface RenderTargetReadbackRequest {
  readonly mipLevel: number;
  /**
   * Cube face, array layer, or 3D depth slice to copy, in
   * `[0, renderTargetLayerCount(descriptor) - 1]`. Omitted means layer 0.
   */
  readonly layer?: number;
}

/** One-shot readback request bound to a future matching FrameReceipt. */
export interface RenderTargetReadbackTicket {
  readonly [RenderTargetReadbackTicketBrand]: 'RenderTargetReadbackTicket';
}

/** Bytes released by observe after the ticket's matching frame completes. */
export interface RenderTargetReadbackData {
  readonly ticket: RenderTargetReadbackTicket;
  readonly bytes: Uint8Array;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly mipLevel: number;
  readonly layer?: number;
  readonly bytesPerRow: number;
  readonly byteLength: number;
}

declare const FramebufferSnapshotTicketBrand: unique symbol;

export interface FramebufferSnapshotRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Copy one region of a submitted frame's linear-HDR scene color into a 2D
 * `rgba16float` RenderTarget. The copy is recorded in the next submitted frame,
 * after scene features and before post-processing, and the target keeps the
 * bytes until another writer replaces them.
 */
export interface FramebufferSnapshotRequest {
  /** Source rectangle in the camera's scene-color pixels (internal extent). */
  readonly region: FramebufferSnapshotRegion;
  /** Destination texel of the region's top-left corner; omitted means (0, 0). */
  readonly destination?: { readonly x: number; readonly y: number };
  /** Camera entity key; required for CameraView frames, omitted selects the display camera. */
  readonly camera?: number;
}

/** One-shot snapshot request bound to the next submitted FrameReceipt. */
export interface FramebufferSnapshotTicket {
  readonly [FramebufferSnapshotTicketBrand]: 'FramebufferSnapshotTicket';
}

/** Released by observe after the matching frame completed and the target holds the copy. */
export interface FramebufferSnapshotData {
  readonly ticket: FramebufferSnapshotTicket;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly camera: number | undefined;
  readonly region: FramebufferSnapshotRegion;
  readonly destination: { readonly x: number; readonly y: number };
  readonly sourceExtent: { readonly width: number; readonly height: number };
}

export interface RenderTargetAdmissionLimits {
  readonly maxTextureDimension2D: number;
  readonly maxTextureDimension3D: number;
  readonly maxTextureArrayLayers: number;
  readonly maxBytesPerTarget: number;
  readonly renderableFormats: readonly RenderTargetFormat[];
  readonly sampleCounts: readonly RenderTargetSampleCount[];
  readonly depthFormats: readonly RenderTargetDepthFormat[];
}

const FORMAT_BYTES: Readonly<Record<RenderTargetFormat, number>> = {
  rgba16float: 8,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
};

function mipFactor(mipLevels: RenderTargetMipLevels): number {
  return mipLevels === 'full' ? 4 / 3 : 1;
}

function estimatedBytes(descriptor: RenderTargetDescriptor): number {
  const layers = renderTargetLayerCount(descriptor);
  const samples = descriptor.sampleCount;
  const depthBytes =
    descriptor.depth === undefined ? 0 : descriptor.depth === 'depth32float-stencil8' ? 8 : 4;
  return Math.ceil(
    descriptor.width *
      descriptor.height *
      FORMAT_BYTES[descriptor.format] *
      layers *
      samples *
      mipFactor(descriptor.mipLevels) +
      // One single-layer depth attachment is shared by every layer write.
      descriptor.width * descriptor.height * depthBytes * samples,
  );
}

function invalid(
  field: string,
  value: unknown,
  expected: string,
): RenderResult<never, RenderError> {
  return {
    ok: false,
    error: new RenderTargetDescriptorInvalidError({ field, value, expected }),
  };
}

/** Validate descriptor facts before a renderer allocates a physical target. */
export function admitRenderTargetDescriptor(
  descriptor: RenderTargetDescriptor,
  limits: RenderTargetAdmissionLimits,
): RenderResult<RenderTargetDescriptor, RenderError> {
  if (!Number.isInteger(descriptor.width) || descriptor.width < 1) {
    return invalid('width', descriptor.width, 'an integer >= 1');
  }
  if (!Number.isInteger(descriptor.height) || descriptor.height < 1) {
    return invalid('height', descriptor.height, 'an integer >= 1');
  }
  const layered = descriptor.shape === '3d' || descriptor.shape === '2d-array';
  if (!layered && descriptor.depthOrArrayLayers !== undefined) {
    return invalid(
      'depthOrArrayLayers',
      descriptor.depthOrArrayLayers,
      `omitted for a ${descriptor.shape} target`,
    );
  }
  if (
    layered &&
    (!Number.isInteger(descriptor.depthOrArrayLayers) || descriptor.depthOrArrayLayers < 1)
  ) {
    return invalid('depthOrArrayLayers', descriptor.depthOrArrayLayers, 'an integer >= 1');
  }
  const maxExtent =
    descriptor.shape === '3d' ? limits.maxTextureDimension3D : limits.maxTextureDimension2D;
  if (descriptor.width > maxExtent || descriptor.height > maxExtent) {
    return invalid(
      'extent',
      { width: descriptor.width, height: descriptor.height },
      `width and height <= ${maxExtent}`,
    );
  }
  switch (descriptor.shape) {
    case '2d':
      break;
    case 'cube':
      if (descriptor.width !== descriptor.height) {
        return invalid('shape', descriptor.shape, 'cube width === height');
      }
      break;
    case '2d-array':
      if (descriptor.depthOrArrayLayers > limits.maxTextureArrayLayers) {
        return {
          ok: false,
          error: new RenderTargetCapabilityMissingError({
            operation: 'create',
            requested: String(descriptor.depthOrArrayLayers),
            capability: 'maxTextureArrayLayers',
            actual: String(limits.maxTextureArrayLayers),
          }),
        };
      }
      break;
    case '3d':
      if (descriptor.depthOrArrayLayers > limits.maxTextureDimension3D) {
        return {
          ok: false,
          error: new RenderTargetCapabilityMissingError({
            operation: 'create',
            requested: String(descriptor.depthOrArrayLayers),
            capability: 'maxTextureDimension3D',
            actual: String(limits.maxTextureDimension3D),
          }),
        };
      }
      if (descriptor.sampleCount !== 1) {
        return invalid('sampleCount', descriptor.sampleCount, '1 for a 3d target');
      }
      if (descriptor.mipLevels !== 1) {
        return invalid('mipLevels', descriptor.mipLevels, '1 for a 3d target');
      }
      break;
  }
  if (!limits.renderableFormats.includes(descriptor.format)) {
    return {
      ok: false,
      error: new RenderTargetCapabilityMissingError({
        operation: 'create',
        requested: descriptor.format,
        capability: 'renderableFormats',
        actual: limits.renderableFormats.join(', '),
      }),
    };
  }
  if (!limits.sampleCounts.includes(descriptor.sampleCount)) {
    return {
      ok: false,
      error: new RenderTargetCapabilityMissingError({
        operation: 'create',
        requested: String(descriptor.sampleCount),
        capability: 'sampleCounts',
        actual: limits.sampleCounts.join(', '),
      }),
    };
  }
  if (descriptor.depth !== undefined && !limits.depthFormats.includes(descriptor.depth)) {
    return {
      ok: false,
      error: new RenderTargetCapabilityMissingError({
        operation: 'create',
        requested: descriptor.depth,
        capability: 'depthFormats',
        actual: limits.depthFormats.join(', '),
      }),
    };
  }
  const bytes = estimatedBytes(descriptor);
  if (bytes > limits.maxBytesPerTarget) {
    return invalid('bytes', bytes, `estimated allocation <= ${limits.maxBytesPerTarget}`);
  }
  return { ok: true, value: descriptor };
}
