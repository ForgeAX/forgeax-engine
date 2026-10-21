import type { TextureMipPolicy, TextureShape } from '@forgeax/engine-types';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function parseTextureShape(value: unknown): TextureShape | undefined {
  if (!record(value) || !record(value.extent)) return undefined;
  const extent = value.extent;
  if (
    value.viewDimension === '2d' &&
    positiveInteger(extent.width) &&
    positiveInteger(extent.height)
  ) {
    if (extent.layers === undefined && extent.depth === undefined) {
      return { viewDimension: '2d', extent: { width: extent.width, height: extent.height } };
    }
  }
  if (
    value.viewDimension === '2d-array' &&
    positiveInteger(extent.width) &&
    positiveInteger(extent.height) &&
    positiveInteger(extent.layers) &&
    extent.depth === undefined
  ) {
    return {
      viewDimension: '2d-array',
      extent: { width: extent.width, height: extent.height, layers: extent.layers },
    };
  }
  if (
    value.viewDimension === '3d' &&
    positiveInteger(extent.width) &&
    positiveInteger(extent.height) &&
    positiveInteger(extent.depth) &&
    extent.layers === undefined
  ) {
    return {
      viewDimension: '3d',
      extent: { width: extent.width, height: extent.height, depth: extent.depth },
    };
  }
  return undefined;
}

export function parseTextureMipPolicy(value: unknown): TextureMipPolicy | undefined {
  if (!record(value)) return undefined;
  if (value.kind === 'none' || value.kind === 'generate') return { kind: value.kind };
  if (value.kind === 'packed' && positiveInteger(value.levelCount)) {
    return { kind: 'packed', levelCount: value.levelCount };
  }
  return undefined;
}
