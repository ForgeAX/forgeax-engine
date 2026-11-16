import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import type {
  CloudMaterialAsset,
  CloudMaterialInstanceAsset,
  CloudParameter,
  CloudParameterValue,
  CloudProgramVariant,
} from '../contracts';
import {
  type CloudAuthoringError,
  type CloudAuthoringLocation,
  cloudAuthoringError,
} from '../errors';
import { cloudIdentity } from './identity';
import { resolveCloudParameters } from './material';

export interface ResolvedCloudMaterial {
  readonly material: CloudMaterialAsset;
  readonly values: Readonly<Record<string, CloudParameterValue>>;
  readonly variant: CloudProgramVariant | undefined;
}

export function verifyCloudTexture(
  parameter: Extract<CloudParameter, { readonly kind: 'texture' }>,
  texture: TextureAsset,
): boolean {
  const extent = texture.shape.extent;
  const maxDimension = Math.max(extent.width, extent.height, 'depth' in extent ? extent.depth : 1);
  const levels =
    texture.mips.kind === 'none'
      ? 1
      : texture.mips.kind === 'generate'
        ? Math.floor(Math.log2(maxDimension)) + 1
        : texture.mips.levelCount;
  const fourChannel = /^(?:rgba(?:8|16|32)|bgra8)/.test(texture.format);
  const encodedSrgb = texture.format.endsWith('-srgb');
  return (
    texture.shape.viewDimension === parameter.dimension &&
    fourChannel &&
    texture.colorSpace === parameter.colorSpace &&
    encodedSrgb === (parameter.colorSpace === 'srgb') &&
    levels === parameter.mipLevels
  );
}

export function resolveCloudMaterial(
  material: CloudMaterialAsset,
  instance: CloudMaterialInstanceAsset | undefined,
  location: CloudAuthoringLocation,
  textures: ReadonlyMap<string, TextureAsset>,
): Result<ResolvedCloudMaterial, CloudAuthoringError> {
  if (
    instance !== undefined &&
    (instance.material !== location.guid ||
      instance.parameterIdentity !== cloudIdentity(material.parameters))
  ) {
    return err(
      cloudAuthoringError(
        'cloud-dependency-invalid',
        location,
        'material',
        'the instance references a different material interface',
      ),
    );
  }
  const values = resolveCloudParameters(material.parameters, instance?.overrides ?? {}, location);
  if (!values.ok) return values;
  const staticValues: Record<string, boolean> = {};
  for (const [name, parameter] of Object.entries(material.parameters)) {
    const value = values.value[name];
    if (parameter.kind === 'static') staticValues[name] = value === true;
    if (parameter.kind === 'texture') {
      const texture = textures.get(String(value));
      if (texture === undefined || !verifyCloudTexture(parameter, texture)) {
        return err(
          cloudAuthoringError(
            'cloud-dependency-invalid',
            location,
            `parameters.${name}`,
            `missing or incompatible cooked texture GUID ${String(value)}`,
          ),
        );
      }
    }
  }
  const identity = cloudIdentity(staticValues);
  const variant = material.variants.find(
    (candidate) => cloudIdentity(candidate.staticValues) === identity,
  );
  if (material.model === 'program' && variant === undefined) {
    return err(
      cloudAuthoringError(
        'cloud-program-invalid',
        location,
        'variants',
        'the selected static variant was not cooked',
      ),
    );
  }
  return ok({ material, values: values.value, variant });
}
