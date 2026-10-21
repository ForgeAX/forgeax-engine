import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import { type BindGroupLayout, type RenderPipeline, RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { GPU_SHADER_STAGE_FRAGMENT } from './gpu-stage';
import { getOrCreateFromChain } from './record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from './record/render-context';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from './render-pipeline';
import { SHADOW_DEPTH_LAYER_USAGE, type ShadowDepthLayers } from './shadow-depth-layers';

export interface VarianceShadowView {
  readonly kind: 'directional' | 'spot';
  readonly index: number;
  readonly depth: RenderPipelineTarget;
  readonly size: number;
  readonly rastered: () => boolean;
}

/** Moment maps follow the same submitted resource lifetime as their depth source. */
export function addVarianceShadowPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  views: readonly VarianceShadowView[],
  retained?: ShadowDepthLayers,
): Result<RenderPipelineTarget | undefined, RenderGraphError> {
  if (views.length === 0) return ok(undefined);
  const size = Math.max(...views.map((view) => view.size));
  const label = 'shadow-variance';
  const descriptor = {
    format: 'rg16float' as const,
    size: { width: size, height: size, depthOrArrayLayers: 8 },
    usage: SHADOW_DEPTH_LAYER_USAGE,
  };
  const texture =
    retained === undefined
      ? graph.createTexture(label, descriptor)
      : graph.importTexture(label, descriptor, () => retained.texture(label, size, 8, 'rg16float'));
  if (!texture.ok) return texture;
  const arrayView = graph.view(texture.value, { dimension: '2d-array', arrayLayerCount: 8 });
  if (!arrayView.ok) return arrayView;
  const result: RenderPipelineTarget = {
    texture: texture.value,
    view: arrayView.value,
    format: 'rg16float',
    sampleCount: 1,
  };
  const parameters = graph.createBuffer('shadow-variance-params', { size: views.length * 256 });
  if (!parameters.ok) return parameters;
  const values = (frame: RenderPipelineFrame, item: VarianceShadowView) => {
    const internal = frame as _InternalRenderPipelineContext;
    const policy = internal.shadowUpdatePolicy?.(item);
    const extent = policy?.viewport ?? [item.size, item.size];
    const radius = policy?.blur?.radius ?? 1;
    const samples = policy?.blur?.samples ?? 8;
    if (
      !Number.isInteger(samples) ||
      samples < 1 ||
      samples > 64 ||
      !Number.isFinite(radius) ||
      radius < 0
    )
      throw new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'variance shadow radius >= 0 and blur samples integer in [1,64]',
        hint: 'repair the light shadow filter parameters',
      });
    const bytes = new ArrayBuffer(32);
    new Float32Array(bytes).set([extent[0], extent[1], radius]);
    new Uint32Array(bytes)[3] = samples;
    new Float32Array(bytes)[4] = item.size / size;
    return new Uint8Array(bytes);
  };
  const uploaded = graph.addCopyPass('shadow-variance-prepare', {
    accesses: [{ resource: parameters.value, usage: 'copy-dst' }],
    encode: ({ frame, resources }) => {
      if (
        (frame as _InternalRenderPipelineContext).pipelineState.extendedLightingAvailable !== true
      )
        throw new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'variance shadow sampled-texture capacity',
          hint: 'use a device with the extended lighting texture budget',
        });
      const buffer = resources.buffer(parameters.value).unwrap();
      for (const [index, view] of views.entries())
        frame.runtime.device.queue.writeBuffer(buffer, index * 256, values(frame, view)).unwrap();
    },
  });
  if (!uploaded.ok) return uploaded;
  type Program = {
    layout: BindGroupLayout;
    vertical: RenderPipeline;
    horizontal: RenderPipeline;
    groups: WeakMap<object, unknown>;
  };
  let program: Program | undefined;
  for (const [ordinal, item] of views.entries()) {
    const layer = item.kind === 'directional' ? item.index : item.index + 4;
    const output = graph.view(texture.value, {
      dimension: '2d',
      baseArrayLayer: layer,
      arrayLayerCount: 1,
    });
    if (!output.ok) return output;
    const vertical = createRenderPipelineTarget(graph, `shadow-variance-${layer}-vertical`, {
      format: 'rg16float',
      size: { width: item.size, height: item.size },
    });
    if (!vertical.ok) return vertical;
    let initial = true;
    let dirty = false;
    for (const phase of ['vertical', 'horizontal'] as const) {
      const target = phase === 'vertical' ? vertical.value.view : output.value;
      const added = graph.addRasterPass(`shadow-variance-${layer}-${phase}`, {
        accesses: [
          { resource: item.depth.view, usage: 'sampled-read' },
          ...(phase === 'horizontal'
            ? [{ resource: vertical.value.view, usage: 'sampled-read' as const }]
            : []),
          { resource: parameters.value, usage: 'uniform-read' },
          { resource: target, usage: 'color-attachment' },
        ],
        colorAttachments: [
          {
            view: target,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 1, g: 0, b: 0, a: 1 },
          },
        ],
        executeIf: (frame) => {
          if (phase === 'vertical') {
            dirty =
              (retained === undefined ? initial : !retained.retained(label, layer)) ||
              item.rastered() ||
              (frame as _InternalRenderPipelineContext).shadowUpdatePolicy?.(item)?.auto === true;
            initial = false;
          }
          return dirty;
        },
        encode: ({ pass, frame, resources }) => {
          const internal = frame as _InternalRenderPipelineContext;
          const device = frame.runtime.device;
          if (program === undefined) {
            const source = internal.runtime.standardDeferredShaders?.shadowVariance;
            const factory = frame.runtime.shaderModuleFactory;
            if (source === undefined || factory === undefined)
              throw new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'cooked variance shadow shader',
                hint: 'rebuild the Engine shader manifest',
              });
            const module = factory
              .createShaderModule({ code: source, label: 'forgeax::engine-shadow-variance' })
              .unwrap();
            const layout = device
              .createBindGroupLayout({
                entries: [
                  {
                    binding: 0,
                    visibility: GPU_SHADER_STAGE_FRAGMENT,
                    buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 },
                  },
                  {
                    binding: 1,
                    visibility: GPU_SHADER_STAGE_FRAGMENT,
                    texture: { sampleType: 'depth', viewDimension: '2d' },
                  },
                  {
                    binding: 2,
                    visibility: GPU_SHADER_STAGE_FRAGMENT,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                  },
                  {
                    binding: 3,
                    visibility: GPU_SHADER_STAGE_FRAGMENT,
                    sampler: { type: 'filtering' },
                  },
                ],
              })
              .unwrap();
            const pipelineLayout = device
              .createPipelineLayout({ bindGroupLayouts: [layout] })
              .unwrap();
            const pipeline = (phase: 'vertical' | 'horizontal') =>
              device
                .createRenderPipeline({
                  label: `${label}-${phase}`,
                  layout: pipelineLayout,
                  vertex: { module, entryPoint: 'vs_main', buffers: [] },
                  fragment: {
                    module,
                    entryPoint: `fs_${phase}`,
                    targets: [{ format: 'rg16float' }],
                  },
                  primitive: { topology: 'triangle-list' },
                })
                .unwrap();
            program = {
              layout,
              vertical: pipeline('vertical'),
              horizontal: pipeline('horizontal'),
              groups: new WeakMap(),
            };
          }
          const buffer = resources.buffer(parameters.value).unwrap();
          const depth = resources.textureView(item.depth.view).unwrap();
          const color =
            phase === 'horizontal'
              ? resources.textureView(vertical.value.view).unwrap()
              : frame.pipelineState.defaultWhiteTextureView;
          const sampler = frame.pipelineState.defaultSampler;
          const layout = program.layout;
          const group = getOrCreateFromChain(
            program.groups,
            [buffer, depth, color, sampler],
            label,
            () =>
              device
                .createBindGroup({
                  layout,
                  entries: [
                    { binding: 0, resource: { kind: 'buffer', value: { buffer, size: 32 } } },
                    { binding: 1, resource: { kind: 'textureView', value: depth } },
                    { binding: 2, resource: { kind: 'textureView', value: color } },
                    { binding: 3, resource: { kind: 'sampler', value: sampler } },
                  ],
                })
                .unwrap(),
            internal.bindGroupCounts,
          );
          pass.setPipeline(program[phase]);
          pass.setBindGroup(0, group, [ordinal * 256]);
          pass.draw(3, 1, 0, 0);
          if (phase === 'horizontal') retained?.rastered(label, layer);
        },
      });
      if (!added.ok) return added;
    }
  }
  return ok(result);
}
