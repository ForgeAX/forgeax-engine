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
import { ok, type Result } from '@forgeax/engine-types';
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
    depth,
    atmosphere.transmittance,
    atmosphere.multipleScattering,
    atmosphere.aerialPerspective,
    atmosphere.aerialTransmittance,
    atmosphere.distantSkyLight,
  ];
  let state: { layout: BindGroupLayout; pipelines: RenderPipeline[]; sampler: Sampler } | undefined;
  const added = graph.addRasterPass('atmosphere-opaque-composition', {
    accesses: [
      ...atmosphereVisibilityAccesses(atmosphere.visibility),
      { resource: view.value, usage: 'uniform-read' },
      ...textures.map((resource) => ({ resource, usage: 'sampled-read' as const })),
      { resource: color.view, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: color.view, loadOp: 'load', storeOp: 'store' }],
    encode: ({ frame, pass, resources }) => {
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
          .createShaderModule({ code: source, label: 'atmosphere_compose' })
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: 2,
                buffer: { type: 'uniform', minBindingSize: VIEW_UNIFORM_BYTES },
              },
              ...textures.map((_, i) => ({
                binding: i + 1,
                visibility: 2,
                texture: {
                  sampleType: (i === 0 ? 'depth' : 'float') as 'depth' | 'float',
                  viewDimension: (i === 3 || i === 4 ? '3d' : '2d') as '3d' | '2d',
                },
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
                entryPoint: `atmosphere_${stage}_fs`,
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
            ...textures.map((texture, i) => ({
              binding: i + 1,
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
