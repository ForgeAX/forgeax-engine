import type {
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  type BindGroupLayout,
  type RenderPipeline,
  RhiError,
  type Sampler,
} from '@forgeax/engine-rhi';
import { ok, type Result, shaderSourceDescriptor } from '@forgeax/engine-types';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';
import type { GraphAtmosphere } from './luts';
import {
  atmosphereVisibilityAccesses,
  atmosphereVisibilityGroup,
  atmosphereVisibilityLayout,
} from './visibility';

export function addAtmosphereComposition(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  color: RenderPipelineTarget,
  depth: GraphTextureView,
  atmosphere: GraphAtmosphere,
): Result<void, RenderGraphError> {
  const view = graph.importBuffer(
    'atmosphere-composition-view',
    { size: VIEW_UNIFORM_BYTES, usage: 0x48 },
    (frame) => frame.pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  const textures = [
    { binding: 1, view: depth, sampleType: 'depth' as const, viewDimension: '2d' as const },
    {
      binding: 2,
      view: atmosphere.transmittance,
      sampleType: 'float' as const,
      viewDimension: '2d' as const,
    },
    {
      binding: 3,
      view: atmosphere.multipleScattering,
      sampleType: 'float' as const,
      viewDimension: '2d' as const,
    },
    {
      binding: 6,
      view: atmosphere.distantSkyLight,
      sampleType: 'float' as const,
      viewDimension: '2d' as const,
    },
    ...(atmosphere.execution === 'compute-volume'
      ? [
          {
            binding: 4,
            view: atmosphere.aerialPerspective,
            sampleType: 'float' as const,
            viewDimension: '3d' as const,
          },
          {
            binding: 5,
            view: atmosphere.aerialTransmittance,
            sampleType: 'float' as const,
            viewDimension: '3d' as const,
          },
        ]
      : [
          {
            binding: 8,
            view: atmosphere.packed,
            sampleType: 'uint' as const,
            viewDimension: '2d' as const,
          },
        ]),
  ];
  let state: { layout: BindGroupLayout; pipelines: RenderPipeline[]; sampler: Sampler } | undefined;
  const added = graph.addRasterPass('atmosphere-opaque-composition', {
    accesses: [
      ...atmosphereVisibilityAccesses(atmosphere.visibility),
      { resource: view.value, usage: 'uniform-read' },
      ...textures.map(({ view: resource }) => ({ resource, usage: 'sampled-read' as const })),
      { resource: color.view, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: color.view, loadOp: 'load', storeOp: 'store' }],
    encodeDirect: (pass, frame, resources) => {
      const device = frame.runtime.device;
      if (state === undefined) {
        const source = frame.atmosphereShaders?.compose;
        const factory = frame.runtime.shaderModuleFactory;
        if (source === undefined || factory === undefined)
          throw new RhiError({
            code: 'shader-compile-failed',
            expected: 'atmosphere composition program',
            hint: 'rebuild the shader manifest',
          });
        const module = factory
          .createShaderModule(shaderSourceDescriptor(source, 'atmosphere_compose'))
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: 2,
                buffer: { type: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
              },
              ...textures.map(({ binding, sampleType, viewDimension }) => ({
                binding,
                visibility: 2,
                texture: { sampleType, viewDimension },
              })),
              { binding: 7, visibility: 2, sampler: { type: 'filtering' } },
            ],
          })
          .unwrap();
        const pipelineLayout = device
          .createPipelineLayout({ bindGroupLayouts: [layout, atmosphereVisibilityLayout(device)] })
          .unwrap();
        const pipelines = ['extinction', 'inscatter'].map((stage) =>
          device
            .createRenderPipeline({
              label: `atmosphere-${stage}`,
              layout: pipelineLayout,
              vertex: { module, entryPoint: 'atmosphere_compose_vs', buffers: [] },
              fragment: {
                module,
                entryPoint: `atmosphere_${atmosphere.execution === 'fragment-cluster' ? 'packed_' : ''}${stage}_fs`,
                targets: [
                  {
                    format: color.format,
                    blend: {
                      color: {
                        operation: 'add',
                        srcFactor: stage === 'extinction' ? 'zero' : 'one',
                        dstFactor: stage === 'extinction' ? 'src' : 'one',
                      },
                      alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
                    },
                  },
                ],
              },
              primitive: { topology: 'triangle-list' },
            })
            .unwrap(),
        );
        state = {
          layout,
          pipelines,
          sampler: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap(),
        };
      }
      const bindings = device
        .createBindGroup({
          layout: state.layout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: resources.buffer(view.value).unwrap(), size: VIEW_UNIFORM_BYTES },
              },
            },
            ...textures.map(({ view: texture, binding }) => ({
              binding,
              resource: {
                kind: 'textureView' as const,
                value: resources.textureView(texture).unwrap(),
              },
            })),
            { binding: 7, resource: { kind: 'sampler', value: state.sampler } },
          ],
        })
        .unwrap();
      for (const pipeline of state.pipelines) {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings);
        pass.setBindGroup(
          1,
          atmosphereVisibilityGroup(
            frame,
            resources.buffer(view.value).unwrap(),
            0,
            atmosphere.visibility.directional === undefined
              ? undefined
              : resources.textureView(atmosphere.visibility.directional).unwrap(),
            atmosphere.visibility.cloud === undefined
              ? undefined
              : resources.textureView(atmosphere.visibility.cloud).unwrap(),
          ),
        );
        pass.draw(3);
      }
    },
  });
  return added.ok ? ok(undefined) : added;
}
