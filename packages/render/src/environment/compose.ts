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
import { SkyPass } from '../record/gpu-pass-timing/sky-pass-names';
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
  const fast = atmosphere.fastAerialPerspective === true;
  const packed = atmosphere.execution === 'fragment-cluster';
  const needsSampler = !packed || !fast;
  const texture2d = (
    binding: number,
    view: GraphTextureView,
    sampleType: 'depth' | 'float' | 'uint' = 'float',
  ) => ({ binding, view, sampleType, viewDimension: '2d' as const });
  const texture3d = (binding: number, view: GraphTextureView) => ({
    binding,
    view,
    sampleType: 'float' as const,
    viewDimension: '3d' as const,
  });
  const textures = [
    texture2d(1, depth, 'depth'),
    ...(!fast
      ? [texture2d(2, atmosphere.transmittance), texture2d(3, atmosphere.multipleScattering)]
      : []),
    texture2d(6, atmosphere.distantSkyLight),
    ...(packed
      ? [texture2d(8, atmosphere.packed, 'uint')]
      : [
          texture3d(4, atmosphere.aerialPerspective),
          ...(atmosphere.aerialTransmittance === undefined
            ? []
            : [texture3d(5, atmosphere.aerialTransmittance)]),
        ]),
  ];
  let state: { layout: BindGroupLayout; pipelines: RenderPipeline[]; sampler: Sampler } | undefined;
  const added = graph.addRasterPass(SkyPass.atmosphereComposition, {
    accesses: [
      ...(!fast ? atmosphereVisibilityAccesses(atmosphere.visibility) : []),
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
              ...(needsSampler
                ? [{ binding: 7, visibility: 2, sampler: { type: 'filtering' as const } }]
                : []),
            ],
          })
          .unwrap();
        const pipelineLayout = device
          .createPipelineLayout({
            bindGroupLayouts: fast ? [layout] : [layout, atmosphereVisibilityLayout(device)],
          })
          .unwrap();
        const pipelines = (fast ? ['fast'] : ['extinction', 'inscatter']).map((stage) =>
          device
            .createRenderPipeline({
              label: `atmosphere-${stage}`,
              layout: pipelineLayout,
              vertex: { module, entryPoint: 'atmosphere_compose_vs', buffers: [] },
              fragment: {
                module,
                entryPoint: `atmosphere_${packed ? 'packed_' : ''}${stage}_fs`,
                targets: [
                  {
                    format: color.format,
                    blend: {
                      color: {
                        operation: 'add',
                        srcFactor: stage === 'extinction' ? 'zero' : 'one',
                        dstFactor: fast ? 'src-alpha' : stage === 'extinction' ? 'src' : 'one',
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
            ...(needsSampler
              ? [{ binding: 7, resource: { kind: 'sampler' as const, value: state.sampler } }]
              : []),
          ],
        })
        .unwrap();
      for (const pipeline of state.pipelines) {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings);
        if (!fast)
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
