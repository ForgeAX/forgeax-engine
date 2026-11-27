import type { Buffer } from '@forgeax/engine-rhi';
import type { DeviceScope } from '../device/device-scope';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { recordContext } from '../world/view-record-context';
import type { BindGroupCounts } from './frame-snapshot';
import type { PipelineState, RenderSystemInternals } from './render-context';

/** Persistent native producers and one exact imported uniform buffer; no recorded frame. */
export interface NativeGraphInputs {
  readonly device: RenderSystemInternals['device'];
  readonly scope: DeviceScope;
  readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory | undefined;
  readonly immediateShaderModuleFactory: PipelineBuilderShaderModuleFactory | undefined;
  readonly viewUniformBuffer: Buffer;
  readonly depthPyramidShaders: RenderSystemInternals['depthPyramidShaders'];
  readonly counts: BindGroupCounts;
  isCurrent(): boolean;
}

export function captureNativeGraphInputs(
  runtime: RenderSystemInternals,
  pipeline: PipelineState,
): NativeGraphInputs {
  const context = recordContext(runtime);
  const scope = context.deviceScope,
    device = runtime.device;
  const factory = runtime.shaderModuleFactory,
    immediate = runtime.immediateShaderModuleFactory;
  return Object.freeze({
    device,
    scope,
    shaderModuleFactory: factory,
    immediateShaderModuleFactory: immediate,
    get viewUniformBuffer() {
      return pipeline.viewUniformBuffer;
    },
    get depthPyramidShaders() {
      return runtime.depthPyramidShaders;
    },
    counts: { createBindGroup: 0, keys: [] },
    isCurrent: () =>
      recordContext(runtime) === context &&
      context.deviceScope === scope &&
      scope.isAlive() &&
      runtime.device === device &&
      context.getPipelineState() === pipeline &&
      runtime.shaderModuleFactory === factory &&
      runtime.immediateShaderModuleFactory === immediate,
  });
}
