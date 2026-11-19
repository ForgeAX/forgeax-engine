import type {
  GraphTextureDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, RenderPipeline, TextureView } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';

/** Nearest covered Reverse-Z sample. Empty pixels remain at the far plane. */
export const MSAA_NEAREST_DEPTH_WGSL = /* wgsl */ `
@group(0) @binding(0) var sourceDepth: texture_depth_multisampled_2d;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_resolve_depth(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 {
  var nearest = 0.0;
  for (var sample = 0u; sample < textureNumSamples(sourceDepth); sample++) {
    nearest = max(nearest, textureLoad(sourceDepth, vec2i(position.xy), i32(sample)));
  }
  return nearest;
}
`;

/** Per-pixel depth for AO/volume consumers; never a center-coverage SceneData producer. */
export function addMsaaNearestDepthResolve(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  depth: RenderPipelineTarget,
  size: GraphTextureDescriptor['size'],
  name: string,
): Result<RenderPipelineTarget, RenderGraphError> {
  const source = graph.view(depth.texture, { dimension: '2d', aspect: 'depth-only' });
  if (!source.ok) return source;
  const target = createRenderPipelineTarget(graph, `${name}-depth`, {
    format: 'depth32float',
    size,
  });
  if (!target.ok) return target;
  let state: { pipeline: RenderPipeline; layout: BindGroupLayout } | undefined;
  let binding: { source: TextureView; group: BindGroup } | undefined;
  const pass = graph.addRasterPass(name, {
    accesses: [
      { resource: source.value, usage: 'sampled-read' },
      { resource: target.value.view, usage: 'depth-stencil-write' },
    ],
    colorAttachments: [],
    depthStencilAttachment: {
      view: target.value.view,
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
    encodeDirect(pass, frame, resources) {
      const device = frame.runtime.device;
      if (state === undefined) {
        const factory =
          frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
        if (factory === undefined)
          throw new RhiError({
            code: 'rhi-not-available',
            expected: 'a depth resolve shader module factory',
            hint: 'construct the renderer through its backend pack',
          });
        const module = factory
          .createShaderModule({ code: MSAA_NEAREST_DEPTH_WGSL, label: 'msaa_nearest_depth' })
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true },
              },
            ],
          })
          .unwrap();
        state = {
          layout,
          pipeline: device
            .createRenderPipeline({
              label: name,
              layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
              vertex: { module, entryPoint: 'vs_main', buffers: [] },
              fragment: { module, entryPoint: 'fs_resolve_depth', targets: [] },
              primitive: { topology: 'triangle-list' },
              depthStencil: {
                format: 'depth32float',
                depthWriteEnabled: true,
                depthCompare: 'always',
              },
            })
            .unwrap(),
        };
      }
      const view = resources.textureView(source.value).unwrap();
      if (binding?.source !== view)
        binding = {
          source: view,
          group: device
            .createBindGroup({
              layout: state.layout,
              entries: [{ binding: 0, resource: { kind: 'textureView', value: view } }],
            })
            .unwrap(),
        };
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, binding.group);
      pass.draw(3);
    },
  });
  return pass.ok ? ok(target.value) : pass;
}
