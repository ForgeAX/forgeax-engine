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
  RhiDevice,
  ShaderModule,
  TextureView,
} from '@forgeax/engine-rhi';
import { type ComputePipelineDescriptor, err, type Result, RhiError } from '@forgeax/engine-rhi';
import { type ShaderSource, shaderSourceDescriptor } from '@forgeax/engine-types';
import { getOrCreateFromChain } from './record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from './record/render-context';
import type { RenderPipelineFrame } from './render-pipeline';
import { markPipelinePreparationPending } from './render-system-presentation';

/** One lazily built renderer-owned compute program plus its bind-group cache. */
export interface ComputeState {
  readonly label: string;
  readonly pipeline: ComputePipeline;
  readonly layout: BindGroupLayout;
  readonly bindGroups: WeakMap<object, unknown>;
}

/** One actual graph stage prepares and records through the same program state. */
export function createComputeStatePreparation(
  source: (frame: RenderGraphFrame) => string | ShaderSource | undefined,
  label: string,
  entries: readonly unknown[],
  entryPoint: string,
  constants?: Readonly<Record<string, number>>,
) {
  let current:
    | {
        readonly device: RhiDevice;
        readonly source: string | ShaderSource;
        readonly layout: BindGroupLayout;
        result?: Result<ComputePipeline, RhiError>;
        state?: ComputeState;
      }
    | undefined;
  return (frame: RenderGraphFrame): ComputeState | undefined => {
    const selected = source(frame);
    if (selected === undefined) return undefined;
    const runtime = (frame as RenderPipelineFrame).runtime;
    if (current === undefined || current.device !== runtime.device || current.source !== selected) {
      const factory = runtime.shaderModuleFactory;
      if (factory === undefined) throw computePipelineError(`${label} shader module`);
      const module = factory.createShaderModule(shaderSourceDescriptor(selected, label));
      if (!module.ok) throw module.error;
      const prepared = computeStateDescriptor(
        runtime.device,
        module.value,
        label,
        entries,
        entryPoint,
        constants,
      );
      const flight = {
        device: runtime.device,
        source: selected,
        layout: prepared.layout,
      } as NonNullable<typeof current>;
      current = flight;
      const create = runtime.device.createComputePipelineAsync;
      const result =
        create === undefined
          ? runtime.device.createComputePipeline(prepared.descriptor)
          : create.call(runtime.device, prepared.descriptor);
      if (result instanceof Promise) {
        // The backend's existing pendingRuntimeCompilation owns the receipt signal.
        result.then(
          (result) => {
            flight.result = result;
          },
          (cause: unknown) => {
            flight.result = err(
              cause instanceof RhiError
                ? cause
                : new RhiError({
                    code: 'webgpu-runtime-error',
                    expected: `${label} native compilation completes`,
                    hint: String(cause),
                  }),
            );
          },
        );
      } else flight.result = result;
    }
    if (current.result === undefined) {
      markPipelinePreparationPending((frame as _InternalRenderPipelineContext).frameState, {
        code: 'scene-pipeline-preparation',
      });
      return undefined;
    }
    if (!current.result.ok) {
      const error = current.result.error;
      current = undefined;
      throw error;
    }
    current.state ??= {
      label,
      pipeline: current.result.value,
      layout: current.layout,
      bindGroups: new WeakMap(),
    };
    return current.state;
  };
}

type ComputeBinding =
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
  source: string | ShaderSource,
  label: string,
  entries: readonly unknown[],
  entryPoint: string,
  constants?: Readonly<Record<string, number>>,
): ComputeState {
  const factory = (frame as RenderPipelineFrame).runtime?.shaderModuleFactory;
  if (factory === undefined) throw computePipelineError(`${label} shader module`);
  const module = factory.createShaderModule(shaderSourceDescriptor(source, label));
  if (!module.ok) throw module.error;
  const device = (frame as RenderPipelineFrame).runtime.device;
  return createComputeStateForModule(device, module.value, label, entries, entryPoint, constants);
}

/** Build against the exact module witness already admitted by its factory. */
export function createComputeStateForModule(
  device: RhiDevice,
  module: ShaderModule,
  label: string,
  entries: readonly unknown[],
  entryPoint: string,
  constants?: Readonly<Record<string, number>>,
): ComputeState {
  const prepared = computeStateDescriptor(device, module, label, entries, entryPoint, constants);
  const pipeline = device.createComputePipeline(prepared.descriptor);
  if (!pipeline.ok) throw pipeline.error;
  return { label, pipeline: pipeline.value, layout: prepared.layout, bindGroups: new WeakMap() };
}

function computeStateDescriptor(
  device: RhiDevice,
  module: ShaderModule,
  label: string,
  entries: readonly unknown[],
  entryPoint: string,
  constants?: Readonly<Record<string, number>>,
): { readonly layout: BindGroupLayout; readonly descriptor: ComputePipelineDescriptor } {
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
  return {
    layout: layout.value,
    descriptor: {
      label,
      layout: pipelineLayout.value,
      compute: { module, entryPoint, ...(constants === undefined ? {} : { constants }) },
    },
  };
}

export function computeBindGroup(
  frame: RenderGraphFrame,
  state: Pick<ComputeState, 'label' | 'layout' | 'bindGroups'>,
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
