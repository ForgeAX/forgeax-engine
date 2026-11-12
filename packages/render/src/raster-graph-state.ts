import type { RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { RenderPipeline } from '@forgeax/engine-rhi';
import { type ShaderSource, shaderSourceDescriptor } from '@forgeax/engine-types';
import { type ComputeState, computePipelineError } from './compute-graph-state';
import type { RenderPipelineFrame } from './render-pipeline';

/** Graph-owned fullscreen program; resource bindings share the ordinary cache. */
export interface RasterState extends Pick<ComputeState, 'label' | 'layout' | 'bindGroups'> {
  readonly pipeline: RenderPipeline;
}

export function createRasterState(
  frame: RenderGraphFrame,
  source: string | ShaderSource,
  label: string,
  entries: readonly unknown[],
  vertex: string,
  fragment: string,
  formats: readonly GPUTextureFormat[],
): RasterState {
  const runtime = (frame as RenderPipelineFrame).runtime;
  const factory = runtime.immediateShaderModuleFactory ?? runtime.shaderModuleFactory;
  if (factory === undefined) throw computePipelineError(`${label} shader module`);
  const module = factory.createShaderModule(shaderSourceDescriptor(source, label)).unwrap();
  const device = runtime.device;
  const layout = device.createBindGroupLayout({ label, entries: entries as never }).unwrap();
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
  const pipeline = device
    .createRenderPipeline({
      label,
      layout: pipelineLayout,
      vertex: { module, entryPoint: vertex, buffers: [] },
      fragment: { module, entryPoint: fragment, targets: formats.map((format) => ({ format })) },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  return { label, layout, pipeline, bindGroups: new WeakMap() };
}
