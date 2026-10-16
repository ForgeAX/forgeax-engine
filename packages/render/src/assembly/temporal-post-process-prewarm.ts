import type { Result, RhiDevice, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import type { ManifestEntry } from '@forgeax/engine-types';
import { postProcessShaderModuleLabel } from '../fullscreen-post-process-pass';
import { invokeDeviceCreateShaderModule } from './material-shader-policy';
import { runShimStep } from './renderer-helpers';

export type AsyncShaderModuleFactory =
  | ((
      device: RhiDevice,
      desc: { readonly code: string; readonly label?: string },
    ) => Promise<Result<ShaderModule, RhiError>>)
  | undefined;

/** Create the shared readiness prewarmer for temporal/fullscreen shader entries. */
export function createTemporalShaderPrewarmer(input: {
  readonly device: RhiDevice;
  readonly asyncCreateShaderModule: AsyncShaderModuleFactory;
  readonly seedShaderModule: (label: string, module: ShaderModule) => void;
}): (entry: ManifestEntry | undefined, id: string) => Promise<void> {
  return async (entry, id): Promise<void> => {
    if (entry === undefined) return;
    const prewarm = await runShimStep(
      () =>
        input.asyncCreateShaderModule
          ? input.asyncCreateShaderModule(input.device, {
              code: entry.wgsl,
              label: postProcessShaderModuleLabel(entry.wgsl),
            })
          : invokeDeviceCreateShaderModule(input.device, {
              code: entry.wgsl,
              label: postProcessShaderModuleLabel(entry.wgsl),
            }),
      'shader-compile-failed',
      `${id} shader module compiled (unified post-process prewarm)`,
      `inspect manifest ${id} entry composed wgsl; check device.features`,
    );
    if (!prewarm.ok) throw prewarm.error;
    input.seedShaderModule(postProcessShaderModuleLabel(entry.wgsl), prewarm.value);
  };
}
