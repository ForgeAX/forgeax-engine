import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { StandardProfile } from '../pipeline/standard-profile';
import type { RenderPipelineTopology } from '../render-pipeline';
import type { MaterialSnapshot } from '../render-system-extract';

/** Derive bounded view demand from the same published material values used by its UBO. */
export function subsurfaceDemand(materials: Iterable<MaterialSnapshot>): boolean {
  const profiles = new Set<number>();
  for (const material of materials) {
    const params = material.paramSnapshot;
    const radius = params?.subsurfaceRadius ?? [0, 0, 0];
    const weight = params?.subsurfaceWeight ?? 0;
    if (
      !Array.isArray(radius) ||
      radius.length !== 3 ||
      radius.some((n) => !Number.isFinite(n) || n < 0 || n > 12) ||
      typeof weight !== 'number' ||
      !Number.isFinite(weight) ||
      weight < 0 ||
      weight > 1
    ) {
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'subsurfaceRadius RGB in [0,12] presentation pixels and weight in [0,1]',
        hint: 'repair the ordinary MaterialAsset values and re-cook the same GUID',
      });
    }
    const bits = radius.map((r) => Math.round((r * 255) / 12));
    if (Math.round(weight * 255) === 0 || bits.every((r) => r === 0)) continue;
    if (
      material.deferredPass !== true ||
      material.surfaceModel !== 'standard' ||
      material.renderState?.blend !== undefined ||
      material.renderState?.depthWriteEnabled === false
    ) {
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'opaque Deferred Standard subsurface surface',
        hint: 'use an opaque Standard root with a Deferred pass',
      });
    }
    profiles.add((bits[0] ?? 0) | ((bits[1] ?? 0) << 8) | ((bits[2] ?? 0) << 16));
    if (profiles.size > 16)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'at most 16 active subsurface RGB profiles per view',
        hint: 'reduce the distinct radius tuples in the ordinary material roster',
      });
  }
  return profiles.size > 0;
}

/** Admit one view's diffusion lane before allocating its graph resources. */
export function subsurfaceTopology(
  materials: Iterable<MaterialSnapshot>,
  profile: StandardProfile | undefined,
  device: RhiDevice,
  unsupportedView: boolean,
): RenderPipelineTopology['subsurface'] {
  if (!subsurfaceDemand(materials)) return undefined;
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

/** Project validated frame rows into the same material-demand admission path. */
export function subsurfaceFrameTopology<
  T extends { readonly source: { readonly materials: readonly MaterialSnapshot[] } },
>(
  renderables: readonly T[],
  profile: StandardProfile | undefined,
  device: RhiDevice,
  unsupportedView: boolean,
): RenderPipelineTopology['subsurface'] {
  return subsurfaceTopology(
    renderables.flatMap((entry) => entry.source.materials),
    profile,
    device,
    unsupportedView,
  );
}
