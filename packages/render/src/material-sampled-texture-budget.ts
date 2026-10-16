import {
  type AssetRegistry,
  walkMaterialPassesOverSharedRefs,
} from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { toShared } from '@forgeax/engine-types';
import {
  STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
  standardTransmissionAdmission,
} from './assembly/device-feature-admission';
import { materialUsesDirectDfgLut } from './device/direct-dfg-lut';
import { isCanonicalStandardPbrMaterialShader } from './pbr-pipeline';
import {
  materialStandardTextureMask,
  runtimeMaterialShaderIdForMaterial,
} from './render-system-extract';

/** WebGPU's guaranteed `maxSampledTexturesPerShaderStage`: the portable authoring budget. */
export const WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE = 16;

/**
 * How one Standard material fits a per-stage sampled-texture limit. Ordinary
 * and `shared` transmission materials use the fixed 16-texture layout;
 * `dedicated` and `exceeded` need the full transmission layout, and an
 * `exceeded` material renders without refraction at this limit.
 */
export interface MaterialSampledTextureBudget {
  readonly limit: number;
  readonly required: number;
  readonly transmission: 'none' | 'dedicated' | 'shared' | 'exceeded';
  /** Authored split scalar maps that block the shared transmission layout. */
  readonly conflicts: readonly string[];
}

/**
 * Evaluate a material's Standard sampled-texture budget through the same
 * authored contract and admission the renderer applies when recording.
 * This query needs no renderer program selection or GPU resource residency.
 * Returns `undefined` for custom shaders, which own their layout.
 */
export function materialSampledTextureBudget(
  world: World,
  assets: AssetRegistry,
  materialHandle: number,
  limit: number = WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE,
): MaterialSampledTextureBudget | undefined {
  const resolved = walkMaterialPassesOverSharedRefs(
    world,
    toShared<'MaterialAsset'>(materialHandle),
    assets,
  );
  if (!resolved.ok) return undefined;
  const { passes, parameters, values } = resolved.value;
  const materialShaderId = runtimeMaterialShaderIdForMaterial(passes, undefined);
  if (!isCanonicalStandardPbrMaterialShader(materialShaderId)) return undefined;
  const admission = standardTransmissionAdmission(
    {
      materialShaderId,
      paramSnapshot:
        typeof values.transmission === 'number' ? { transmission: values.transmission } : undefined,
      standardTextureMask: materialStandardTextureMask(parameters, materialShaderId, values),
    },
    limit,
  );
  const transmission = admission?.kind ?? 'none';
  return {
    limit,
    required:
      (transmission === 'dedicated' || transmission === 'exceeded'
        ? STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES
        : WEBGPU_MIN_SAMPLED_TEXTURES_PER_SHADER_STAGE) +
      (materialUsesDirectDfgLut(parameters) ? 1 : 0),
    transmission,
    conflicts: admission?.kind === 'exceeded' ? admission.conflicts : [],
  };
}
