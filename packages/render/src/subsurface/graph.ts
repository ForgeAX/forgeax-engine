import type { GraphTextureView, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupLayout,
  type ComputePipeline,
  type RenderPipeline,
  RhiError,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';

/** Keep precise HDR deltas in one bounded band, with horizontal scratch in the workgroup. */
export function addSubsurfaceDiffusion(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: {
    readonly scene: RenderPipelineTarget;
    readonly diffuse: RenderPipelineTarget;
    readonly profiles: GraphTextureView;
    readonly normal: GraphTextureView;
    readonly depth: GraphTextureView;
    readonly size: { readonly width: number; readonly height: number };
    readonly scale: readonly [number, number];
    readonly quality: 'low' | 'high';
  },
) {
  const bandHeight = Math.min(64, input.size.height);
  const scratch = graph.createTexture('subsurface-delta', {
    size: { width: input.size.width, height: bandHeight },
    format: 'rgba32float',
    domain: 'linear-hdr',
  });
  if (!scratch.ok) return scratch;
  const delta = graph.view(scratch.value, { dimension: '2d' });
  if (!delta.ok) return delta;
  const views = [input.diffuse.view, input.profiles, input.normal, input.depth, delta.value];
  let state:
    | { pipeline: ComputePipeline; layout: BindGroupLayout; groups: WeakMap<object, unknown> }
    | undefined;
  let composition:
    | { pipeline: RenderPipeline; layout: BindGroupLayout; groups: WeakMap<object, unknown> }
    | undefined;
  for (let origin = 0; origin < input.size.height; origin += bandHeight) {
    const suffix = origin === 0 ? '' : `-${origin}`;
    const rows = Math.min(bandHeight, input.size.height - origin);
    // Each dispatch owns immutable parameters. Queue writes all precede submission.
    const params = graph.createBuffer(`subsurface-params-${origin}`, { size: 32 });
    if (!params.ok) return params;
    const upload = graph.addCopyPass(`subsurface-prepare${suffix}`, {
      accesses: [{ resource: params.value, usage: 'copy-dst' }],
      encode: ({ frame, resources }) => {
        const camera = frame.camera;
        frame.runtime.device.queue
          .writeBuffer(
            resources.buffer(params.value).unwrap(),
            0,
            new Float32Array([
              camera.near,
              camera.far,
              camera.projection === 'orthographic' ? 1 : 0,
              input.quality === 'low' ? 2 : 3,
              input.scale[0],
              input.scale[1],
              origin,
              rows,
            ]),
          )
          .unwrap();
      },
    });
    if (!upload.ok) return upload;
    const compute = graph.addComputePass(`subsurface-diffusion${suffix}`, {
      accesses: [
        ...views.slice(0, 4).map((resource) => ({ resource, usage: 'sampled-read' as const })),
        { resource: delta.value, usage: 'storage-write' },
        { resource: params.value, usage: 'uniform-read' },
      ],
      encode: ({ pass, frame, resources }) => {
        const internal = frame as _InternalRenderPipelineContext;
        const device = frame.runtime.device;
        if (state === undefined) {
          const code = internal.runtime.standardDeferredShaders?.subsurface;
          if (code === undefined)
            throw new RhiError({
              code: 'shader-compile-failed',
              expected: 'cooked Standard subsurface diffusion shader',
              hint: 'rebuild shared shader inputs and initialize the Renderer',
            });
          const module = frame.runtime.shaderModuleFactory
            ?.createShaderModule({
              code,
              label: 'forgeax::engine-subsurface-diffusion',
            })
            .unwrap();
          if (module === undefined)
            throw new RhiError({
              code: 'rhi-not-available',
              expected: 'subsurface shader module factory',
              hint: 'initialize the Renderer backend',
            });
          const layout = device
            .createBindGroupLayout({
              entries: [
                ...[0, 1, 2, 3].map((binding) => ({
                  binding,
                  visibility: 4,
                  texture: {
                    sampleType:
                      binding === 1 || binding === 2
                        ? ('uint' as const)
                        : binding === 3
                          ? ('depth' as const)
                          : ('unfilterable-float' as const),
                    viewDimension: '2d' as const,
                  },
                })),
                { binding: 4, visibility: 4, buffer: { type: 'uniform', minBindingSize: 32 } },
                {
                  binding: 5,
                  visibility: 4,
                  storageTexture: {
                    access: 'write-only',
                    format: 'rgba32float',
                    viewDimension: '2d',
                  },
                },
              ],
            })
            .unwrap();
          const pipeline = device
            .createComputePipeline({
              label: 'subsurface-diffusion',
              layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
              compute: { module, entryPoint: 'cs_subsurface' },
            })
            .unwrap();
          state = { pipeline, layout, groups: new WeakMap() };
        }
        const textures = views.map((view) => resources.textureView(view).unwrap());
        const buffer = resources.buffer(params.value).unwrap();
        const current = state;
        const group = getOrCreateFromChain(
          current.groups,
          [...textures, buffer],
          'subsurface',
          () =>
            device
              .createBindGroup({
                layout: current.layout,
                entries: [
                  ...textures.map((texture, i) => ({
                    binding: i < 4 ? i : 5,
                    resource: { kind: 'textureView' as const, value: texture },
                  })),
                  { binding: 4, resource: { kind: 'buffer' as const, value: { buffer } } },
                ],
              })
              .unwrap(),
          internal.bindGroupCounts,
        );
        pass.setPipeline(current.pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(input.size.width / 8), Math.ceil(rows / 8), 1);
      },
    });
    if (!compute.ok) return compute;
    const compose = graph.addRasterPass(`subsurface-compose${suffix}`, {
      accesses: [
        { resource: delta.value, usage: 'sampled-read' },
        { resource: params.value, usage: 'uniform-read' },
        { resource: input.scene.view, usage: 'color-attachment' },
      ],
      colorAttachments: [{ view: input.scene.view, loadOp: 'load', storeOp: 'store' }],
      encode: ({ pass, frame, resources }) => {
        const internal = frame as _InternalRenderPipelineContext;
        const device = frame.runtime.device;
        if (composition === undefined) {
          const code = internal.runtime.standardDeferredShaders?.subsurface;
          const factory = frame.runtime.shaderModuleFactory;
          if (code === undefined || factory === undefined)
            throw new RhiError({
              code: 'shader-compile-failed',
              expected: 'cooked Standard subsurface composition shader and module factory',
              hint: 'rebuild shared shader inputs and initialize the Renderer',
            });
          const module = factory
            .createShaderModule({ code, label: 'forgeax::engine-subsurface-diffusion' })
            .unwrap();
          const layout = device
            .createBindGroupLayout({
              entries: [
                { binding: 4, visibility: 2, buffer: { type: 'uniform', minBindingSize: 32 } },
                {
                  binding: 6,
                  visibility: 2,
                  texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
                },
              ],
            })
            .unwrap();
          const pipeline = device
            .createRenderPipeline({
              label: 'subsurface-compose',
              layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
              vertex: { module, entryPoint: 'vs_subsurface', buffers: [] },
              fragment: {
                module,
                entryPoint: 'fs_subsurface',
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
          composition = { pipeline, layout, groups: new WeakMap() };
        }
        const texture = resources.textureView(delta.value).unwrap();
        const buffer = resources.buffer(params.value).unwrap();
        const current = composition;
        const group = getOrCreateFromChain(
          current.groups,
          [texture, buffer],
          'subsurface-compose',
          () =>
            device
              .createBindGroup({
                layout: current.layout,
                entries: [
                  { binding: 4, resource: { kind: 'buffer', value: { buffer, size: 32 } } },
                  { binding: 6, resource: { kind: 'textureView', value: texture } },
                ],
              })
              .unwrap(),
          internal.bindGroupCounts,
        ) as BindGroup;
        pass.setPipeline(current.pipeline);
        pass.setBindGroup(0, group);
        pass.setScissorRect(0, origin, input.size.width, rows);
        pass.draw(3);
      },
    });
    if (!compose.ok) return compose;
  }
  return ok(undefined);
}
