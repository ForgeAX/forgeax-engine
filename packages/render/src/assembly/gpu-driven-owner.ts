import { err, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';

/**
 * Renderer-owned GPU-driven frame state boundary. The production object owns
 * view resources and prepared generations; callers only supply the backend
 * and shader factory and must not create a parallel frame loop.
 */
export function createGpuDrivenOwner(
  device: RhiDevice,
  shaderModuleFactory?: PipelineBuilderShaderModuleFactory,
  recoveryCount = 0,
): GpuDrivenProduction {
  return new GpuDrivenProduction(
    device,
    shaderModuleFactory ?? {
      createShaderModule: () =>
        err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'the renderer backend exposes shader module creation',
            hint: 'construct the renderer through the backend pack before activating GPU-driven rendering',
          }),
        ),
    },
    recoveryCount,
  );
}
