import type { TextureMipPolicy, TextureShape } from '@forgeax/engine-types';
import {
  err,
  ok,
  type Result,
  type TextureError,
  validateTextureShape,
} from '@forgeax/engine-types';

/** Versioned source-side declaration for one logical sampled texture. */
export interface TextureSourceDescriptor {
  readonly schemaVersion: '1';
  readonly shape: TextureShape;
  readonly format: GPUTextureFormat;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mips: TextureMipPolicy;
  readonly rawSibling: string;
}

export interface TextureSourceDescriptorError {
  readonly code: 'texture-source-descriptor-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string; readonly actual: unknown };
}

export type TextureSourceDescriptorResult = Result<
  TextureSourceDescriptor,
  TextureSourceDescriptorError | TextureError
>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseShape(value: unknown): TextureShape | undefined {
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

function parseMips(value: unknown): TextureMipPolicy | undefined {
  if (!record(value)) return undefined;
  if (value.kind === 'none' || value.kind === 'generate') return { kind: value.kind };
  if (value.kind === 'packed' && positiveInteger(value.levelCount)) {
    return { kind: 'packed', levelCount: value.levelCount };
  }
  return undefined;
}

function descriptorError(field: string, actual: unknown): TextureSourceDescriptorError {
  return {
    code: 'texture-source-descriptor-invalid',
    expected: 'version 1 descriptor with shape, format, colorSpace, mips, and rawSibling',
    hint: 'repair the texture descriptor and re-import the same texture GUID',
    detail: { field, actual },
  };
}

/** Parse and validate source facts before any raw sibling bytes are consumed. */
export function parseTextureSourceDescriptor(value: unknown): TextureSourceDescriptorResult {
  if (!record(value)) return err(descriptorError('descriptor', value));
  if (value.schemaVersion !== '1')
    return err(descriptorError('schemaVersion', value.schemaVersion));
  const shape = parseShape(value.shape);
  if (shape === undefined) return err(descriptorError('shape', value.shape));
  const mips = parseMips(value.mips);
  if (mips === undefined) return err(descriptorError('mips', value.mips));
  if (typeof value.format !== 'string') return err(descriptorError('format', value.format));
  if (value.colorSpace !== 'srgb' && value.colorSpace !== 'linear') {
    return err(descriptorError('colorSpace', value.colorSpace));
  }
  if (typeof value.rawSibling !== 'string' || value.rawSibling.trim().length === 0) {
    return err(descriptorError('rawSibling', value.rawSibling));
  }
  const shapeResult = validateTextureShape(shape, mips, value.format as GPUTextureFormat);
  if (!shapeResult.ok) return shapeResult;
  return ok({
    schemaVersion: '1',
    shape,
    format: value.format as GPUTextureFormat,
    colorSpace: value.colorSpace,
    mips,
    rawSibling: value.rawSibling,
  });
}
