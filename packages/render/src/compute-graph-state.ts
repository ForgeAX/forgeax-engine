import type {
  GraphBuffer,
  GraphResourceResolver,
  GraphTextureView,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { getOrCreateFromChain } from './record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from './record/render-context';
import type { RenderPipelineFrame } from './render-pipeline';

/** One lazily built renderer-owned compute program plus its bind-group cache. */
export interface ComputeState {
  readonly label: string;
  readonly pipeline: ComputePipeline;
  readonly layout: BindGroupLayout;
  readonly bindGroups: WeakMap<object, unknown>;
}

export type ComputeBinding =
  | {
      readonly binding: number;
      readonly resource: { readonly kind: 'textureView'; readonly value: TextureView };
    }
  | {
      readonly binding: number;
      readonly resource: {
        readonly kind: 'buffer';
        readonly value: { readonly buffer: Buffer; readonly size?: number };
      };
    };

export function computePipelineError(stage: string): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: `${stage} compute pipeline to be available`,
    hint: 'construct the renderer through a backend pack with shader module support',
  });
}

/**
 * Build one compute program. `label` must equal the manifest stage label the
 * renderer prewarms, otherwise the first production frame races the async
 * shader adapter instead of hitting the seeded module cache.
 */
export function createComputeState(
  frame: RenderGraphFrame,
  source: string,
  label: string,
  entries: readonly unknown[],
  entryPoint: string,
): ComputeState {
  const factory = (frame as RenderPipelineFrame).runtime?.shaderModuleFactory;
  if (factory === undefined) throw computePipelineError(`${label} shader module`);
  const module = factory.createShaderModule({ code: source, label });
  if (!module.ok) throw module.error;
  const device = (frame as RenderPipelineFrame).runtime.device;
  const layout = device.createBindGroupLayout({
    label: `${label}.bind-group-layout`,
    entries: entries as never,
  });
  if (!layout.ok) throw layout.error;
  const pipelineLayout = device.createPipelineLayout({
    label: `${label}.pipeline-layout`,
    bindGroupLayouts: [layout.value],
  });
  if (!pipelineLayout.ok) throw pipelineLayout.error;
  const pipeline = device.createComputePipeline({
    label,
    layout: pipelineLayout.value,
    compute: { module: module.value, entryPoint },
  });
  if (!pipeline.ok) throw pipeline.error;
  return { label, pipeline: pipeline.value, layout: layout.value, bindGroups: new WeakMap() };
}

export function computeBindGroup(
  frame: RenderGraphFrame,
  state: ComputeState,
  entries: readonly ComputeBinding[],
): BindGroup {
  const device = (frame as RenderPipelineFrame).runtime.device;
  return getOrCreateFromChain(
    state.bindGroups,
    entries.map(({ resource }) =>
      resource.kind === 'buffer' ? resource.value.buffer : resource.value,
    ),
    state.label,
    () => device.createBindGroup({ layout: state.layout, entries }).unwrap(),
    (frame as _InternalRenderPipelineContext).bindGroupCounts,
  );
}

export function resolvedGraphView(
  resources: GraphResourceResolver,
  view: GraphTextureView,
): TextureView {
  const resolved = resources.textureView(view);
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
}

export function resolvedGraphBuffer(resources: GraphResourceResolver, buffer: GraphBuffer): Buffer {
  const resolved = resources.buffer(buffer);
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
}
