import type { ComputePipeline, RenderPipeline, RhiRenderPipelineOps } from '@forgeax/engine-rhi';
import type { HandleId } from '../types';
import { pushEvent, type RecorderInternal, registerHandle } from './core';

export function wrapPipeline<T extends RenderPipeline | ComputePipeline>(
  state: RecorderInternal,
  pipeline: T,
  pipelineHandleId: HandleId,
): T {
  // Preserve native pipeline identity: renderer-owned command paths may pass
  // the opaque handle directly to WebGPU, which rejects a JavaScript Proxy.
  const operation = (pipeline as T & Partial<RhiRenderPipelineOps>).getBindGroupLayout;
  if (operation === undefined) return pipeline;
  const getLayout = operation.bind(pipeline);
  Object.defineProperty(pipeline, 'getBindGroupLayout', {
    configurable: true,
    value: (index: number) => {
      const layout = getLayout(index);
      const event = {
        kind: 'getBindGroupLayout' as const,
        handleId: '' as HandleId,
        pipelineHandleId,
        index,
      };
      registerHandle(state, layout, 'bindGroupLayout', event);
      pushEvent(state, event);
      return layout;
    },
  });
  return pipeline;
}
