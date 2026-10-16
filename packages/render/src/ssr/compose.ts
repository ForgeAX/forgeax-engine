import type {
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, RenderPipeline, Sampler } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';

/** Material response is produced with the visible surface; composition never
 * redraws that surface, so equal-depth overlaps cannot apply the delta twice. */
export function addSsrCompositionPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: {
    readonly scene: RenderPipelineTarget;
    readonly radiance: GraphTextureView;
    readonly fallback: GraphTextureView;
    readonly response: GraphTextureView;
    readonly normal: GraphTextureView;
    readonly view: GraphBuffer;
  },
) {
  let state:
    | {
        pipeline: RenderPipeline;
        layout: BindGroupLayout;
        sampler: Sampler;
        groups: WeakMap<object, unknown>;
      }
    | undefined;
  const views = [input.radiance, input.fallback, input.response, input.normal];
  return graph.addRasterPass('ssr-compose', {
    accesses: [
      ...views.map((resource) => ({ resource, usage: 'sampled-read' as const })),
      { resource: input.view, usage: 'uniform-read' },
      { resource: input.scene.view, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: input.scene.view, loadOp: 'load', storeOp: 'store' }],
    encode: ({ pass, frame, resources }) => {
      const source = frame.ssrShaders?.compose;
      if (source === undefined) return;
      const device = frame.runtime.device;
      if (state === undefined) {
        const factory = frame.runtime.shaderModuleFactory;
        if (factory === undefined)
          throw new RhiError({
            code: 'rhi-not-available',
            expected: 'SSR composition shader module factory',
            hint: 'construct the renderer through a backend pack with shader module support',
          });
        const module = factory.createShaderModule({ code: source, label: 'ssr_compose' }).unwrap();
        const layout = device
          .createBindGroupLayout({
            entries: [
              ...views.map((_, binding) => ({
                binding,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: {
                  sampleType:
                    binding === 0
                      ? ('float' as const)
                      : binding === 3
                        ? ('uint' as const)
                        : ('unfilterable-float' as const),
                  viewDimension: '2d' as const,
                },
              })),
              {
                binding: 4,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                sampler: { type: 'filtering' as const },
              },
              {
                binding: 5,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                buffer: { type: 'uniform' as const },
              },
            ],
          })
          .unwrap();
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: 'ssr_compose',
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_ssr_compose', buffers: [] },
            fragment: {
              module,
              entryPoint: 'fs_ssr_compose',
              targets: [
                {
                  format: input.scene.format,
                  blend: {
                    color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
                    alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
                  },
                },
              ],
            },
            primitive: { topology: 'triangle-list' },
          })
          .unwrap();
        const sampler = device
          .createSampler({
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            minFilter: 'linear',
            magFilter: 'linear',
            mipmapFilter: 'linear',
          })
          .unwrap();
        state = { pipeline, layout, sampler, groups: new WeakMap() };
      }
      const textures = views.map((view) => resources.textureView(view).unwrap());
      const viewBuffer = resources.buffer(input.view).unwrap();
      const layout = state.layout;
      const sampler = state.sampler;
      const group = getOrCreateFromChain(
        state.groups,
        [...textures, sampler, viewBuffer],
        'ssr-compose',
        () =>
          device
            .createBindGroup({
              layout,
              entries: [
                ...textures.map((value, binding) => ({
                  binding,
                  resource: { kind: 'textureView' as const, value },
                })),
                { binding: 4, resource: { kind: 'sampler' as const, value: sampler } },
                {
                  binding: 5,
                  resource: {
                    kind: 'buffer' as const,
                    value: { buffer: viewBuffer, size: VIEW_UNIFORM_BYTES },
                  },
                },
              ],
            })
            .unwrap(),
        (frame as _InternalRenderPipelineContext).bindGroupCounts,
      ) as BindGroup;
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
    },
  });
}
