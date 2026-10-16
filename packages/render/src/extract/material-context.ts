import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from '../assembly/shader-prewarm-policy';
import { atmosphereAvailable } from '../environment/capability';
import { EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES } from '../prepare/extended-lighting/resources';

/** The receiving device selects the immutable material program domain. */
export function renderMaterialContext(
  caps: Pick<RhiCaps, 'backendKind' | 'storageBuffer'>,
  limits?: Readonly<{ maxSampledTexturesPerShaderStage?: number }>,
  visibleSurface = false,
): {
  readonly materialContext?: MaterialCookRasterContext;
} {
  // Null records the WGSL material domain structurally. Its device/receipt
  // still reports `null`; this selection never claims GPU shader validation.
  return {
    materialContext: {
      backend:
        caps.backendKind === 'null'
          ? 'webgpu'
          : caps.backendKind === 'wgpu-webgl2'
            ? 'webgl2'
            : caps.backendKind,
      capability: atmosphereAvailable(caps.storageBuffer, limits?.maxSampledTexturesPerShaderStage)
        ? 'storage-buffer-atmosphere'
        : caps.storageBuffer
          ? limits?.maxSampledTexturesPerShaderStage === undefined ||
            limits.maxSampledTexturesPerShaderStage >= EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES
            ? 'storage-buffer'
            : limits.maxSampledTexturesPerShaderStage >= STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES
              ? 'storage-buffer-projector'
              : 'storage-buffer-minimum'
          : 'uniform-fallback',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
      ...(visibleSurface ? { visibleSurface: true } : {}),
    },
  };
}
