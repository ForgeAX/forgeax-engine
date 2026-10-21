import type { TextureAsset } from '@forgeax/engine-types';
import {
  err,
  ok,
  type Result,
  type TextureError,
  validateTextureShape,
} from '@forgeax/engine-types';
import { parseTextureMipPolicy, parseTextureShape } from './parse-layout';

/** Versioned source-side declaration for one logical sampled texture. */
export interface TextureSourceDescriptor
  extends Pick<TextureAsset, 'shape' | 'format' | 'colorSpace' | 'mips'> {
  readonly schemaVersion: '1';
  readonly rawSibling: string;
}

export interface TextureSourceDescriptorError {
  readonly code: 'texture-source-descriptor-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string; readonly actual: unknown };
}

type TextureSourceDescriptorResult = Result<
  TextureSourceDescriptor,
  TextureSourceDescriptorError | TextureError
>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  const shape = parseTextureShape(value.shape);
  if (shape === undefined) return err(descriptorError('shape', value.shape));
  const mips = parseTextureMipPolicy(value.mips);
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
