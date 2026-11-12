import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, RenderPipeline } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../render-pipeline';

/** Graph pass that seeds `scene-depth` from the Forward surface-data prepass. */
export const FORWARD_DEPTH_SEED_PASS = 'forward-depth-seed';

/**
 * Forward `main` may start from the surface-data prepass depth only when that
 * prepass is a single-sample raster of the same depth format. MSAA scene depth
 * keeps its own clear: one prepass sample cannot stand for four.
 */
export function forwardDepthSeedAdmitted(
  source: RenderPipelineTarget | undefined,
  destination: RenderPipelineTarget,
): source is RenderPipelineTarget {
  return (
    source !== undefined &&
    source.sampleCount === 1 &&
    destination.sampleCount === 1 &&
    source.format === destination.format
  );
}

/**
 * Seeds `destination` from the surface-data prepass depth when admitted.
 * Resolves to whether `main` must load the seeded depth instead of clearing.
 */
export function seedForwardSceneDepth(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  source: RenderPipelineTarget | undefined,
  destination: RenderPipelineTarget,
): Result<boolean, RenderGraphError> {
  if (!forwardDepthSeedAdmitted(source, destination)) return ok(false);
  const seed = addForwardDepthSeedPass(graph, source, destination);
  return seed.ok ? ok(true) : seed;
}

// Reversed-Z: `greater` is nearer. The prepass raster writes exactly the
// depth `main` will produce for the same fragment (`@invariant` clip position,
// identical coverage), and the seed copies it unchanged. `main` then accepts
// equal depth (`greater-equal`), so the first fragment at the visible depth
// still passes and every hidden fragment is rejected before shading; an
// alpha-masked program draws with `equal` and no depth write, so its
// fragments outside the prepass coverage never shade (UE
// r.EarlyZPassOnlyMaterialMasking). Cleared pixels stay at the far plane.
// Stencil is cleared here because `main` now loads it.
export const FORWARD_DEPTH_SEED_WGSL = /* wgsl */ `
@group(0) @binding(0) var prepassDepth : texture_depth_2d;

@vertex
fn vs_forward_depth_seed(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs_forward_depth_seed(@builtin(position) position : vec4<f32>) -> @builtin(frag_depth) f32 {
  let depth = textureLoad(prepassDepth, vec2<i32>(position.xy), 0);
  return depth;
}
`;

export function addForwardDepthSeedPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  source: RenderPipelineTarget,
  destination: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  const sampled = graph.view(source.texture, {
    label: `${FORWARD_DEPTH_SEED_PASS}.source`,
    dimension: '2d',
    aspect: 'depth-only',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!sampled.ok) return sampled;
  let state:
    | { pipeline: RenderPipeline; layout: BindGroupLayout; groups: WeakMap<object, unknown> }
    | undefined;
  return graph.addRasterPass(FORWARD_DEPTH_SEED_PASS, {
    accesses: [
      { resource: sampled.value, usage: 'sampled-read' },
      { resource: destination.view, usage: 'depth-stencil-write' },
    ],
    colorAttachments: [],
    depthStencilAttachment: {
      view: destination.view,
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      stencilClearValue: 0,
      stencilLoadOp: 'clear',
      stencilStoreOp: 'store',
    },
    encodeDirect: (pass, frame, resources) => {
      const device = frame.runtime.device;
      if (state === undefined) {
        const factory =
          frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
        if (factory === undefined)
          throw new RhiError({
            code: 'rhi-not-available',
            expected: 'Forward depth seed shader module factory',
            hint: 'construct the renderer through a backend pack with shader module support',
          });
        const module = factory
          .createShaderModule({ code: FORWARD_DEPTH_SEED_WGSL, label: 'forward_depth_seed' })
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            label: 'forward-depth-seed-bgl',
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'depth' as const, viewDimension: '2d' as const },
              },
            ],
          })
          .unwrap();
        const pipelineLayout = device
          .createPipelineLayout({ label: 'forward-depth-seed-pl', bindGroupLayouts: [layout] })
          .unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: 'forward_depth_seed',
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_forward_depth_seed', buffers: [] },
            fragment: { module, entryPoint: 'fs_forward_depth_seed', targets: [] },
            primitive: { topology: 'triangle-list' },
            depthStencil: {
              format: destination.format as GPUTextureFormat,
              depthWriteEnabled: true,
              depthCompare: 'always',
            },
          })
          .unwrap();
        state = { pipeline, layout, groups: new WeakMap() };
      }
      const view = resources.textureView(sampled.value).unwrap();
      const layout = state.layout;
      const group = getOrCreateFromChain(
        state.groups,
        [view],
        'forward-depth-seed',
        () =>
          device
            .createBindGroup({
              label: 'forward-depth-seed-bg',
              layout,
              entries: [{ binding: 0, resource: { kind: 'textureView' as const, value: view } }],
            })
            .unwrap(),
        (frame as _InternalRenderPipelineContext).bindGroupCounts,
      ) as BindGroup;
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3, 1);
    },
  });
}
