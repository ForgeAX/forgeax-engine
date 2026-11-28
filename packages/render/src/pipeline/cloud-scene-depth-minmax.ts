import type {
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupLayout,
  type RenderPipeline,
  RhiError,
  type TextureView,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { CLOUD_DEPTH_RANGE_QUARTER } from '../cloud/contracts';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../render-pipeline';

const HALF_DEPTH_RANGE = 'cloud-scene-depth-minmax-half';

export const CLOUD_SCENE_DEPTH_MINMAX_WGSL = /* wgsl */ `
@group(0) @binding(0) var opaqueDepth: texture_depth_2d;
@group(0) @binding(1) var halfRange: texture_2d<f32>;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn source_pixel(base: vec2i, tap: i32, last: vec2i) -> vec2i {
  return min(base + vec2i(tap % 2, tap / 2), last);
}

// Preserve reverse Device Z, including zero for sky.
@fragment fn fs_half(@builtin(position) position: vec4f) -> @location(0) vec2f {
  let base = vec2i(position.xy) * 2;
  let last = vec2i(textureDimensions(opaqueDepth)) - vec2i(1);
  var farZ = 1.0;
  var nearZ = 0.0;
  for (var tap = 0; tap < 4; tap += 1) {
    let z = textureLoad(opaqueDepth, source_pixel(base, tap, last), 0);
    farZ = min(farZ, z);
    nearZ = max(nearZ, z);
  }
  return vec2f(farZ, nearZ);
}

@fragment fn fs_quarter(@builtin(position) position: vec4f) -> @location(0) vec2f {
  let base = vec2i(position.xy) * 2;
  let last = vec2i(textureDimensions(halfRange)) - vec2i(1);
  var farZ = 1.0;
  var nearZ = 0.0;
  for (var tap = 0; tap < 4; tap += 1) {
    let z = textureLoad(halfRange, source_pixel(base, tap, last), 0).rg;
    farZ = min(farZ, z.r);
    nearZ = max(nearZ, z.g);
  }
  return vec2f(farZ, nearZ);
}
`;

type DepthRangeGraph = RenderGraphBuilder<RenderPipelineFrame>;
type Extent = Readonly<{ width: number; height: number }>;

function halfExtent({ width, height }: Extent): Extent {
  return { width: Math.ceil(width / 2), height: Math.ceil(height / 2) };
}

function addDepthRangePass(
  graph: DepthRangeGraph,
  name: string,
  size: Extent,
  input: GraphTextureView,
  stage: 'half' | 'quarter',
): Result<RenderPipelineTarget, RenderGraphError> {
  const format = 'rg16float';
  const target = createRenderPipelineTarget(graph, name, {
    format,
    size,
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  });
  if (!target.ok) return target;
  const output = target.value;
  const bindingIndex = stage === 'half' ? 0 : 1;
  let program: { pipeline: RenderPipeline; layout: BindGroupLayout } | undefined;
  let binding: { source: TextureView; group: BindGroup } | undefined;
  const added = graph.addRasterPass(name, {
    accesses: [
      { resource: input, usage: 'sampled-read' },
      { resource: output.view, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: output.view, loadOp: 'clear', storeOp: 'store' }],
    encodeDirect(pass, frame, resources) {
      const device = frame.runtime.device;
      if (program === undefined) {
        const factory =
          frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
        if (factory === undefined) {
          throw new RhiError({
            code: 'rhi-not-available',
            expected: 'a cloud scene depth shader module factory',
            hint: 'construct the renderer through its backend pack',
          });
        }
        const module = factory
          .createShaderModule({ code: CLOUD_SCENE_DEPTH_MINMAX_WGSL, label: name })
          .unwrap();
        const layout = device
          .createBindGroupLayout({
            entries: [
              {
                binding: bindingIndex,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: {
                  sampleType: stage === 'half' ? 'depth' : 'unfilterable-float',
                  viewDimension: '2d',
                },
              },
            ],
          })
          .unwrap();
        program = {
          layout,
          pipeline: device
            .createRenderPipeline({
              label: name,
              layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
              vertex: { module, entryPoint: 'vs_main', buffers: [] },
              fragment: { module, entryPoint: `fs_${stage}`, targets: [{ format }] },
              primitive: { topology: 'triangle-list' },
            })
            .unwrap(),
        };
      }
      const source = resources.textureView(input).unwrap();
      if (binding?.source !== source) {
        binding = {
          source,
          group: device
            .createBindGroup({
              layout: program.layout,
              entries: [
                { binding: bindingIndex, resource: { kind: 'textureView', value: source } },
              ],
            })
            .unwrap(),
        };
      }
      pass.setPipeline(program.pipeline);
      pass.setBindGroup(0, binding.group);
      pass.draw(3);
    },
  });
  return added.ok ? target : added;
}

export function addCloudSceneDepthMinMax(
  graph: DepthRangeGraph,
  depth: RenderPipelineTarget,
  size: Extent,
): Result<
  { readonly half: RenderPipelineTarget; readonly quarter: RenderPipelineTarget },
  RenderGraphError
> {
  const source = graph.view(depth.texture, { dimension: '2d', aspect: 'depth-only' });
  if (!source.ok) return source;
  const halfSize = halfExtent(size);
  const half = addDepthRangePass(graph, HALF_DEPTH_RANGE, halfSize, source.value, 'half');
  if (!half.ok) return half;
  const quarter = addDepthRangePass(
    graph,
    CLOUD_DEPTH_RANGE_QUARTER,
    halfExtent(halfSize),
    half.value.view,
    'quarter',
  );
  return quarter.ok ? ok({ half: half.value, quarter: quarter.value }) : quarter;
}
