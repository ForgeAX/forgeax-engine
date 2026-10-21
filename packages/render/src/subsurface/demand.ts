import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { StandardProfile } from '../pipeline/standard-profile';
import type { RenderPipelineTopology } from '../render-pipeline';
import type { SubsurfaceDemand } from './selection';

/** Validate the fixed selection result before allocating view resources. */
export function subsurfaceDemand(demand: SubsurfaceDemand): boolean {
  if (demand === 'missing-material')
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'an accepted material version for every selected surface',
      hint: 'prepare the material frame and scene selection from the same publication',
    });
  if (demand === 'invalid-values')
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'subsurfaceRadius RGB in [0,12] presentation pixels and weight in [0,1]',
      hint: 'repair the ordinary MaterialAsset values and re-cook the same GUID',
    });
  if (demand === 'invalid-surface')
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'opaque Deferred Standard subsurface surface',
      hint: 'use an opaque Standard root with a Deferred pass',
    });
  if (demand > 16)
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'at most 16 active subsurface RGB profiles per view',
      hint: 'reduce the distinct radius tuples in the ordinary material roster',
    });
  return demand > 0;
}

/** Admit one view's diffusion lane before allocating its graph resources. */
export function subsurfaceTopology(
  demand: SubsurfaceDemand,
  profile: StandardProfile | undefined,
  device: RhiDevice,
  unsupportedView: boolean,
): RenderPipelineTopology['subsurface'] {
  if (!subsurfaceDemand(demand)) return undefined;
  if (profile?.renderPath !== 'deferred' || profile.diffuseGi !== undefined || unsupportedView) {
    throw new RhiError({
      code: 'rhi-descriptor-invalid',
      expected:
        'single-sample Deferred subsurface display/target view without GI or cube/planar captures',
      hint: 'select the supported Standard profile and remove the unsupported combination',
    });
  }
  if (
    !device.caps.compute ||
    !device.caps.storageTexture ||
    !device.caps.float32Filterable ||
    !device.features.has('float32-blendable') ||
    (device.limits.maxComputeWorkgroupStorageSize ?? 0) < 32768
  ) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected:
        'subsurface diffusion: compute/storage textures, float32 HDR sampling/blending and 32768-byte workgroup storage',
      hint: 'select a device that supports the bounded precise HDR diffusion lane',
    });
  }
  return { quality: profile.subsurfaceQuality ?? 'high' };
}
