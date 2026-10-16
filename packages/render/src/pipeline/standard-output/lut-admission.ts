import type { SamplerDescriptor } from '@forgeax/engine-rhi';
import type { TextureAsset } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';

export type StandardLutAdmissionErrorCode =
  | 'standard-lut-shape-invalid'
  | 'standard-lut-limit-exceeded'
  | 'standard-lut-filter-unavailable'
  | 'standard-lut-bind-failed';

export type StandardLutAdmissionError = {
  readonly code: StandardLutAdmissionErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, number | string | boolean>>;
};

export interface StandardColorLutAdmissionInput {
  readonly texture: TextureAsset;
  readonly maxTextureDimension3D: number;
  readonly rgba16floatFilterable: boolean;
  readonly bind: () => boolean;
}

export interface StandardColorLutAdmission {
  readonly viewDimension: '3d';
  readonly extent: Readonly<{ width: number; height: number; depth: number }>;
  readonly sampler: SamplerDescriptor;
}

export function createStandardLutSamplerDescriptor(): SamplerDescriptor {
  return {
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
  };
}

function failure(
  code: StandardLutAdmissionErrorCode,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, number | string | boolean>>,
): Result<never, StandardLutAdmissionError> {
  return err({ code, expected, hint, detail });
}

export function admitStandardColorLut(
  input: StandardColorLutAdmissionInput,
): Result<StandardColorLutAdmission, StandardLutAdmissionError> {
  const { texture } = input;
  if (
    texture.shape.viewDimension !== '3d' ||
    texture.format !== 'rgba16float' ||
    texture.colorSpace !== 'linear' ||
    texture.mips.kind === 'generate' ||
    (texture.mips.kind === 'packed' && texture.mips.levelCount !== 1)
  ) {
    return failure(
      'standard-lut-shape-invalid',
      'a linear rgba16float 3D texture with one resident mip level',
      're-import the LUT as an ordinary linear 3D TextureAsset without generated mips',
      {
        viewDimension: texture.shape.viewDimension,
        format: texture.format,
        colorSpace: texture.colorSpace,
        mipPolicy: texture.mips.kind,
      },
    );
  }

  const extent = texture.shape.extent;
  if (extent.width !== extent.height || extent.width !== extent.depth) {
    return failure(
      'standard-lut-shape-invalid',
      'LUT width, height, and depth must be equal',
      'produce a cubic 3D LUT',
      { width: extent.width, height: extent.height, depth: extent.depth },
    );
  }
  if (
    !Number.isInteger(input.maxTextureDimension3D) ||
    input.maxTextureDimension3D <= 0 ||
    extent.width > input.maxTextureDimension3D
  ) {
    return failure(
      'standard-lut-limit-exceeded',
      'the LUT extent must fit the live maxTextureDimension3D limit',
      'use a smaller LUT or select a device with a larger 3D texture limit',
      { size: extent.width, maxTextureDimension3D: input.maxTextureDimension3D },
    );
  }
  if (!input.rgba16floatFilterable) {
    return failure(
      'standard-lut-filter-unavailable',
      'rgba16float 3D sampling must be filterable on the live device',
      'disable the LUT or use a device that exposes rgba16float filtering',
      { format: texture.format, rgba16floatFilterable: false },
    );
  }
  if (!input.bind()) {
    return failure(
      'standard-lut-bind-failed',
      'the LUT view and sampler must bind on the live device',
      'disable the LUT and retain the last known good output',
      { size: extent.width },
    );
  }
  return ok({
    viewDimension: '3d',
    extent: { width: extent.width, height: extent.height, depth: extent.depth },
    sampler: createStandardLutSamplerDescriptor(),
  });
}
