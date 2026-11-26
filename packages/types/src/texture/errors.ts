import { err, ok, type Result } from '../result.js';
import type { CustomTextureMipPolicy, TextureMipPolicy, TextureShape } from './asset.js';
import { isCompressedFormat } from './block.js';
import { numMipLevels } from './mips.js';

export type TextureErrorCode = keyof TextureErrorDetailMap;

type TextureErrorDetailMap = {
  'texture-shape-invalid': {
    readonly viewDimension: TextureShape['viewDimension'];
    readonly extent: Readonly<Record<string, number>>;
    readonly field: string;
  };
  'texture-packing-invalid': {
    readonly expectedBytes: number;
    readonly actualBytes: number;
    readonly mip?: number;
    readonly image?: number;
    readonly order?: string;
  };
  'texture-mip-policy-invalid': {
    readonly viewDimension: TextureShape['viewDimension'];
    readonly policy: (TextureMipPolicy | CustomTextureMipPolicy)['kind'];
  };
  'texture-format-dimension-unsupported': {
    readonly format: GPUTextureFormat;
    readonly viewDimension: TextureShape['viewDimension'];
  };
};

export type TextureErrorDetail<C extends TextureErrorCode = TextureErrorCode> = {
  readonly code: C;
} & TextureErrorDetailMap[C];

export type TextureError = {
  [C in TextureErrorCode]: {
    readonly code: C;
    readonly expected: string;
    readonly hint: string;
    readonly detail: TextureErrorDetail<C>;
  };
}[TextureErrorCode];

export const TEXTURE_ERROR_HINTS: Readonly<Record<TextureErrorCode, string>> = {
  'texture-shape-invalid': 'repair the source extent and re-import the same texture GUID',
  'texture-packing-invalid': 'rebuild the producer output with canonical mip-major packing',
  'texture-mip-policy-invalid': 'use none or packed for this texture shape',
  'texture-format-dimension-unsupported':
    'choose a format supported by the requested texture dimension',
};

export function textureError<C extends TextureErrorCode>(
  code: C,
  detail: TextureErrorDetail<C>,
  expected: string,
): TextureError {
  return {
    code,
    expected,
    hint: TEXTURE_ERROR_HINTS[code],
    detail,
  } as TextureError;
}

function positiveAxis(value: number | undefined): boolean {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

/** Validate the sampled shape and source mip policy before layout derivation. */
export function validateTextureShape(
  shape: TextureShape,
  mips?: TextureMipPolicy | CustomTextureMipPolicy,
  format?: GPUTextureFormat,
): Result<void, TextureError> {
  if (mips?.kind === 'custom' && !customMipCountFits(shape, mips.levelCount))
    return err(
      textureError(
        'texture-mip-policy-invalid',
        {
          code: 'texture-mip-policy-invalid',
          viewDimension: shape.viewDimension,
          policy: 'custom',
        },
        'custom GPU mip count must fit the 2D extent',
      ),
    );

  const extent = shape.extent;
  const fields: Readonly<Record<string, number>> = extent;
  let invalidField: string | undefined;
  let widthRead = false;
  let heightRead = false;
  let slicesRead = false;
  const dimension = shape.viewDimension;
  const slices = dimension === '3d' ? 'depth' : dimension === '2d-array' ? 'layers' : undefined;
  // Consume all authored values before reporting the first failure, including
  // getters after an invalid field. Avoid an entries array and a pair per axis.
  for (const field in fields) {
    if (!Object.hasOwn(fields, field)) continue;
    const value = fields[field];
    if (!positiveAxis(value)) invalidField ??= field;
    if (field === 'width') widthRead = true;
    else if (field === 'height') heightRead = true;
    else if (field === slices) slicesRead = true;
  }
  // A descriptor may expose a required dimension as an inherited or non-enumerable property.
  if (!widthRead && !positiveAxis(fields.width)) invalidField ??= 'width';
  if (!heightRead && !positiveAxis(fields.height)) invalidField ??= 'height';
  if (slices !== undefined && !slicesRead && !positiveAxis(fields[slices])) invalidField ??= slices;
  if (invalidField !== undefined) {
    return err(
      textureError(
        'texture-shape-invalid',
        {
          code: 'texture-shape-invalid',
          viewDimension: shape.viewDimension,
          extent,
          field: invalidField,
        },
        `${shape.viewDimension} ${invalidField} must be a positive integer`,
      ),
    );
  }

  if (mips?.kind === 'packed' && (!Number.isInteger(mips.levelCount) || mips.levelCount <= 0)) {
    return err(
      textureError(
        'texture-mip-policy-invalid',
        {
          code: 'texture-mip-policy-invalid',
          viewDimension: shape.viewDimension,
          policy: mips.kind,
        },
        'packed mip policy requires a positive integer levelCount',
      ),
    );
  }
  if (shape.viewDimension === '3d' && mips?.kind === 'generate') {
    return err(
      textureError(
        'texture-mip-policy-invalid',
        {
          code: 'texture-mip-policy-invalid',
          viewDimension: shape.viewDimension,
          policy: mips.kind,
        },
        '3d textures require none or packed mip policy',
      ),
    );
  }

  return validateTextureFormat(dimension, format);
}

function customMipCountFits(shape: TextureShape, count: number): boolean {
  return (
    shape.viewDimension !== '3d' &&
    Number.isSafeInteger(count) &&
    count >= 1 &&
    count <= numMipLevels(shape.extent)
  );
}

function validateTextureFormat(
  viewDimension: TextureShape['viewDimension'],
  format: GPUTextureFormat | undefined,
): Result<void, TextureError> {
  if (format !== undefined && (format.startsWith('depth') || format.startsWith('stencil'))) {
    return err(
      textureError(
        'texture-format-dimension-unsupported',
        {
          code: 'texture-format-dimension-unsupported',
          format,
          viewDimension,
        },
        'authored sampled textures cannot use depth or stencil formats',
      ),
    );
  }
  if (format !== undefined && viewDimension === '3d' && isCompressedFormat(format)) {
    return err(
      textureError(
        'texture-format-dimension-unsupported',
        {
          code: 'texture-format-dimension-unsupported',
          format,
          viewDimension,
        },
        'compressed 3d textures are not supported by this contract',
      ),
    );
  }
  return ok(undefined);
}
