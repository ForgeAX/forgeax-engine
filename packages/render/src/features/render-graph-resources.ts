import type {
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { Buffer } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RenderFeatureResolvedGpuBuffer } from './prepared-gpu-work';

export interface RenderFeatureGraphBufferState {
  readonly handles: Map<Buffer, GraphBuffer>;
  readonly labelCounts: Map<string, number>;
}

export function createRenderFeatureGraphBufferState(): RenderFeatureGraphBufferState {
  return { handles: new Map(), labelCounts: new Map() };
}

export function importRenderFeatureGraphBuffer<FrameCtx extends RenderGraphFrame>(
  builder: RenderGraphBuilder<FrameCtx>,
  state: RenderFeatureGraphBufferState,
  label: string,
  resource: RenderFeatureResolvedGpuBuffer,
): Result<GraphBuffer, RenderGraphError> {
  const existing = state.handles.get(resource.buffer);
  if (existing !== undefined) return ok(existing);
  const count = state.labelCounts.get(label) ?? 0;
  state.labelCounts.set(label, count + 1);
  const imported = builder.importBuffer(
    count === 0 ? label : `${label}.${count}`,
    { size: resource.size, usage: resource.physicalUsage },
    () => resource.buffer,
  );
  if (!imported.ok) return imported;
  state.handles.set(resource.buffer, imported.value);
  return imported;
}
