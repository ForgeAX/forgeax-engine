import { err, ok, type Result } from '../result.js';
import type { TextureMipPolicy, TextureShape } from './asset.js';
import { isCompressedFormat } from './block.js';

export type TextureErrorCode =
  | 'texture-shape-invalid'
  | 'texture-packing-invalid'
  | 'texture-mip-policy-invalid'
  | 'texture-format-dimension-unsupported';

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
    readonly policy: TextureMipPolicy['kind'];
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

/** Validate the closed shape and first-release policy before layout derivation. */
export function validateTextureShape(
  shape: TextureShape,
  mips?: TextureMipPolicy,
  format?: GPUTextureFormat,
): Result<void, TextureError> {
  const extent = shape.extent;
  for (const [field, value] of Object.entries(extent)) {
    if (!Number.isInteger(value) || value <= 0) {
      return err(
        textureError(
          'texture-shape-invalid',
          { code: 'texture-shape-invalid', viewDimension: shape.viewDimension, extent, field },
          `${shape.viewDimension} ${field} must be a positive integer`,
        ),
      );
    }
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

  if (format !== undefined && (format.startsWith('depth') || format.startsWith('stencil'))) {
    return err(
      textureError(
        'texture-format-dimension-unsupported',
        {
          code: 'texture-format-dimension-unsupported',
          format,
          viewDimension: shape.viewDimension,
        },
        'authored sampled textures cannot use depth or stencil formats',
      ),
    );
  }
  if (format !== undefined && shape.viewDimension === '3d' && isCompressedFormat(format)) {
    return err(
      textureError(
        'texture-format-dimension-unsupported',
        {
          code: 'texture-format-dimension-unsupported',
          format,
          viewDimension: shape.viewDimension,
        },
        'compressed 3d textures are not supported by this contract',
      ),
    );
  }
  return ok(undefined);
}
