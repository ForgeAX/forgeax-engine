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
fn nearestSample(pixel: vec2i) -> vec2u {
  var nearest = 0.0;
  var selected = 0u;
  for (var sample = 0u; sample < textureNumSamples(sourceDepth); sample++) {
    let depth = textureLoad(sourceDepth, pixel, i32(sample));
    if (depth > nearest) {
      nearest = depth;
      selected = sample;
    }
  }
  return vec2u(bitcast<u32>(nearest), selected);
}
@fragment fn fs_resolve_depth(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 {
  return bitcast<f32>(nearestSample(vec2i(position.xy)).x);
}
@group(0) @binding(1) var sourceTemporal: texture_multisampled_2d<f32>;
struct Surface {
  @builtin(frag_depth) depth: f32,
  @location(0) temporal: vec4f,
};
@fragment fn fs_resolve_surface(@builtin(position) position: vec4f) -> Surface {
  let pixel = vec2i(position.xy);
  let hit = nearestSample(pixel);
  return Surface(bitcast<f32>(hit.x), textureLoad(sourceTemporal, pixel, i32(hit.y)));
}
`;

/** Resolve one sample identity for the screen depth and, when requested, its motion. */
export function addMsaaNearestDepthResolve(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  depth: RenderPipelineTarget,
  size: GraphTextureDescriptor['size'],
  name: string,
  options: {
    readonly temporal?: RenderPipelineTarget | undefined;
    readonly format?: 'depth32float' | 'depth32float-stencil8';
  } = {},
): Result<
  { readonly depth: RenderPipelineTarget; readonly temporal?: RenderPipelineTarget },
  RenderGraphError
> {
  const source = graph.view(depth.texture, { dimension: '2d', aspect: 'depth-only' });
  if (!source.ok) return source;
  const { temporal: sourceTemporal, format = 'depth32float' } = options;
  const target = createRenderPipelineTarget(graph, `${name}-depth`, {
    format,
    size,
  });
  if (!target.ok) return target;
  const motion =
    sourceTemporal === undefined
      ? ok(undefined)
      : createRenderPipelineTarget(graph, 'standard-scene-temporal', {
          format: 'rgba16float',
          size,
        });
  if (!motion.ok) return motion;
  const temporal = motion.value;
  let state: { pipeline: RenderPipeline; layout: BindGroupLayout } | undefined;
  let binding:
    | { source: TextureView; temporal: TextureView | undefined; group: BindGroup }
    | undefined;
  const pass = graph.addRasterPass(name, {
    accesses: [
      { resource: source.value, usage: 'sampled-read' },
      { resource: target.value.view, usage: 'depth-stencil-write' },
      ...(sourceTemporal === undefined || temporal === undefined
        ? []
        : [
            { resource: sourceTemporal.view, usage: 'sampled-read' as const },
            { resource: temporal.view, usage: 'color-attachment' as const },
          ]),
    ],
    colorAttachments:
      temporal === undefined ? [] : [{ view: temporal.view, loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: {
      view: target.value.view,
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      ...(format.includes('stencil') ? { stencilReadOnly: true } : {}),
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
              ...(sourceTemporal === undefined
                ? []
                : [
                    {
                      binding: 1,
                      visibility: GPU_SHADER_STAGE_FRAGMENT,
                      texture: {
                        sampleType: 'unfilterable-float' as const,
                        viewDimension: '2d' as const,
                        multisampled: true,
                      },
                    },
                  ]),
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
              fragment: {
                module,
                entryPoint: temporal === undefined ? 'fs_resolve_depth' : 'fs_resolve_surface',
                targets: temporal === undefined ? [] : [{ format: temporal.format }],
              },
              primitive: { topology: 'triangle-list' },
              depthStencil: {
                format,
                depthWriteEnabled: true,
                depthCompare: 'always',
              },
            })
            .unwrap(),
        };
      }
      const view = resources.textureView(source.value).unwrap();
      const temporalView =
        sourceTemporal === undefined
          ? undefined
          : resources.textureView(sourceTemporal.view).unwrap();
      if (binding?.source !== view || binding.temporal !== temporalView)
        binding = {
          source: view,
          temporal: temporalView,
          group: device
            .createBindGroup({
              layout: state.layout,
              entries: [
                { binding: 0, resource: { kind: 'textureView', value: view } },
                ...(temporalView === undefined
                  ? []
                  : [
                      {
                        binding: 1,
                        resource: { kind: 'textureView' as const, value: temporalView },
                      },
                    ]),
              ],
            })
            .unwrap(),
        };
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(0, binding.group);
      pass.draw(3);
    },
  });
  return pass.ok
    ? ok({ depth: target.value, ...(temporal === undefined ? {} : { temporal }) })
    : pass;
}
