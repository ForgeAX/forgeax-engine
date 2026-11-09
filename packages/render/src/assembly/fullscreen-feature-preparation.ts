import {
  err,
  ok,
  type Result,
  type RhiDevice,
  RhiError,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import type { RenderFeature } from '../features/types';
import { postProcessShaderModuleLabel } from '../fullscreen-post-process-pass';
import {
  invokeDeviceCreateShaderModule,
  type ShaderDeviceAdapterInternal,
} from './material-shader-policy';
import type { WebGPURendererInternals } from './webgpu-renderer-bootstrap';

// forgeax-async-whitelist: dom-native - prepare the declared native shader modules.
export async function prewarmFullscreenFeatureModules(
  internals: Pick<WebGPURendererInternals, 'pack' | 'errorRegistry'>,
  feature: RenderFeature<unknown>,
  device: RhiDevice,
  adapter: ShaderDeviceAdapterInternal,
  retain: (label: string, module: ShaderModule) => void,
  generationIsCurrent: () => boolean,
): Promise<Result<void, RhiError>> {
  for (const postProcess of feature.requiredFullscreenPostProcesses ?? []) {
    const label = postProcessShaderModuleLabel(postProcess.source);
    const shaderResult = internals.pack.createShaderModule
      ? await internals.pack.createShaderModule(device, {
          code: postProcess.source,
          label,
        })
      : await invokeDeviceCreateShaderModule(device, {
          code: postProcess.source,
          label,
        });
    if (!shaderResult.ok) {
      internals.errorRegistry.fire(shaderResult.error);
      return err(shaderResult.error);
    }
    if (!generationIsCurrent())
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'the installing Feature keeps its device generation',
          hint: 'retry Feature installation after Renderer recovery',
        }),
      );
    retain(label, shaderResult.value);
    adapter.seedModule(label, shaderResult.value, postProcess.source);
  }
  return ok(undefined);
}
