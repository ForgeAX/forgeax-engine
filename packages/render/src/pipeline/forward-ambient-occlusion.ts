import {
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroup, BindGroupLayout, RenderPipeline, Sampler } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type {
  RenderPipelineFrame,
  RenderPipelineTarget,
  RenderPipelineTopology,
} from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';
import { getSsaoParameters } from '../ssao-config';
import { addTypedSsaoPasses } from '../typed-render-graph-primitives';

export const FORWARD_AO_NORMAL_PASS = 'forward-ao-normal';
export const FORWARD_AO_COMPOSITE_PASS = 'forward-ao-composite';

/** Forward AO samples single-sample scene depth, like the opaque fog passes. */
export function forwardAmbientOcclusionSampleCountError(): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-resolution-failed',
    expected: 'Forward ambient occlusion receives single-sample scene depth',
    hint: 'select FXAA, TAA or no AA for Forward AO, or renderPath deferred',
    detail: { resourceLabel: 'scene-depth' },
  });
}

const FULLSCREEN_WGSL = /* wgsl */ `
struct FullscreenOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index : u32) -> FullscreenOut {
  let p = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  var out : FullscreenOut;
  out.position = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2<f32>(p.x, 1.0 - p.y);
  return out;
}
`;

// World normals reconstructed from depth, as Three r184 GTAONode does when it
// has no normal node (getNormalFromDepth): each axis differentiates toward the
// neighbor with the smaller depth step, so silhouettes keep the near surface.
// The encoding repeats forgeax_pbr::gbuffer::encodeStandardNormalRoughness so
// the shared SSAO/GTAO passes read this target like the Deferred G-buffer.
const FORWARD_AO_NORMAL_WGSL = /* wgsl */ `
${FULLSCREEN_WGSL}
struct ViewPrefix {
  worldViewProj : mat4x4<f32>,
  lightDir : vec3<f32>,
  lightingChannels : u32,
  lightColor : vec3<f32>,
  viewportWidth : f32,
  cameraPos : vec3<f32>,
  viewportHeight : f32,
  lightViewProj_A : mat4x4<f32>,
  inverseViewProj : mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> view : ViewPrefix;
@group(0) @binding(1) var sceneDepth : texture_depth_2d;

fn encodeNormal(normal : vec3<f32>) -> u32 {
  let n = normalize(normal);
  var oct = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) {
    oct = (1.0 - abs(oct.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), oct >= vec2<f32>(0.0));
  }
  let uv = vec2<u32>(round(clamp(oct * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0)) * 4095.0));
  return uv.x | (uv.y << 12u) | (255u << 24u);
}

// xyz = world position, w = raw depth.
fn worldAt(pixel : vec2<i32>, size : vec2<i32>) -> vec4<f32> {
  let p = clamp(pixel, vec2<i32>(0), size - 1);
  let depth = textureLoad(sceneDepth, p, 0);
  let uv = (vec2<f32>(p) + 0.5) / vec2<f32>(size);
  let world = view.inverseViewProj * vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return vec4<f32>(world.xyz / world.w, depth);
}

@fragment
fn fs_main(in : FullscreenOut) -> @location(0) u32 {
  let size = vec2<i32>(textureDimensions(sceneDepth));
  let pixel = vec2<i32>(in.position.xy);
  let center = worldAt(pixel, size);
  let toCamera = view.cameraPos - center.xyz;
  // Background texels carry no occluder; the AO passes skip depth <= 0.
  if (center.w <= 0.0) { return encodeNormal(toCamera); }
  let left = worldAt(pixel - vec2<i32>(1, 0), size);
  let right = worldAt(pixel + vec2<i32>(1, 0), size);
  let up = worldAt(pixel - vec2<i32>(0, 1), size);
  let down = worldAt(pixel + vec2<i32>(0, 1), size);
  let dx = select(center.xyz - left.xyz, right.xyz - center.xyz, abs(right.w - center.w) < abs(center.w - left.w));
  let dy = select(center.xyz - up.xyz, down.xyz - center.xyz, abs(down.w - center.w) < abs(center.w - up.w));
  var normal = cross(dy, dx);
  if (dot(normal, normal) <= 0.0) { return encodeNormal(toCamera); }
  if (dot(normal, toCamera) < 0.0) { normal = -normal; }
  return encodeNormal(normal);
}
`;

// Three r184 GTAOPass / the TSL ao() node post-multiply visibility onto the
// lit beauty pass. Forward has no current-frame AO before shading, so it
// multiplies the opaque scene once; translucent writers composite afterwards.
const FORWARD_AO_COMPOSITE_WGSL = /* wgsl */ `
${FULLSCREEN_WGSL}
@group(0) @binding(0) var ambientOcclusion : texture_2d<f32>;
@group(0) @binding(1) var ambientOcclusionSampler : sampler;

@fragment
fn fs_main(in : FullscreenOut) -> @location(0) vec4<f32> {
  let visibility = clamp(textureSampleLevel(ambientOcclusion, ambientOcclusionSampler, in.uv, 0.0).r, 0.0, 1.0);
  return vec4<f32>(visibility, visibility, visibility, 1.0);
}
`;

function shaderModule(frame: RenderPipelineFrame, code: string, label: string) {
  const factory = frame.runtime.immediateShaderModuleFactory ?? frame.runtime.shaderModuleFactory;
  if (factory === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'Forward AO shader module factory',
      hint: 'construct the renderer through a backend pack with shader module support',
    });
  return factory.createShaderModule({ code, label }).unwrap();
}

function addForwardAoNormalPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  depth: GraphTextureView,
  normal: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  const view = graph.importBuffer(
    'forward-ao-view',
    { size: VIEW_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
    (frame) => frame.pipelineState.viewUniformBuffer,
  );
  if (!view.ok) return view;
  let state:
    | { pipeline: RenderPipeline; layout: BindGroupLayout; groups: WeakMap<object, unknown> }
    | undefined;
  return graph.addRasterPass(FORWARD_AO_NORMAL_PASS, {
    accesses: [
      { resource: depth, usage: 'sampled-read' },
      { resource: view.value, usage: 'uniform-read' },
      { resource: normal.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: normal.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    encode: ({ pass, frame, resources }) => {
      const device = frame.runtime.device;
      if (state === undefined) {
        const module = shaderModule(frame, FORWARD_AO_NORMAL_WGSL, 'forward_ao_normal');
        const layout = device
          .createBindGroupLayout({
            label: 'forward-ao-normal-bgl',
            entries: [
              { binding: 0, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
              {
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'depth', viewDimension: '2d' },
              },
            ],
          })
          .unwrap();
        const pipelineLayout = device
          .createPipelineLayout({ label: 'forward-ao-normal-pl', bindGroupLayouts: [layout] })
          .unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: 'forward_ao_normal',
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_main', buffers: [] },
            fragment: { module, entryPoint: 'fs_main', targets: [{ format: normal.format }] },
            primitive: { topology: 'triangle-list' },
          })
          .unwrap();
        state = { pipeline, layout, groups: new WeakMap() };
      }
      const depthView = resources.textureView(depth).unwrap();
      const uniform = resources.buffer(view.value).unwrap();
      const layout = state.layout;
      const group = getOrCreateFromChain(
        state.groups,
        [depthView, uniform],
        'forward-ao-normal',
        () =>
          device
            .createBindGroup({
              label: 'forward-ao-normal-bg',
              layout,
              entries: [
                {
                  binding: 0,
                  resource: {
                    kind: 'buffer' as const,
                    value: { buffer: uniform, size: VIEW_UNIFORM_BYTES },
                  },
                },
                {
                  binding: 1,
                  resource: { kind: 'textureView' as const, value: depthView as never },
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

function addForwardAoCompositePass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  ambientOcclusion: RenderPipelineTarget,
  color: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  let state:
    | {
        pipeline: RenderPipeline;
        layout: BindGroupLayout;
        sampler: Sampler;
        groups: WeakMap<object, unknown>;
      }
    | undefined;
  return graph.addRasterPass(FORWARD_AO_COMPOSITE_PASS, {
    accesses: [
      { resource: ambientOcclusion.view, usage: 'sampled-read' },
      { resource: color.view, usage: 'color-attachment' },
    ],
    colorAttachments: [{ view: color.view, loadOp: 'load', storeOp: 'store' }],
    encode: ({ pass, frame, resources }) => {
      const device = frame.runtime.device;
      if (state === undefined) {
        const module = shaderModule(frame, FORWARD_AO_COMPOSITE_WGSL, 'forward_ao_composite');
        const layout = device
          .createBindGroupLayout({
            label: 'forward-ao-composite-bgl',
            entries: [
              {
                binding: 0,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                texture: { sampleType: 'float', viewDimension: '2d' },
              },
              {
                binding: 1,
                visibility: GPU_SHADER_STAGE_FRAGMENT,
                sampler: { type: 'filtering' },
              },
            ],
          })
          .unwrap();
        const pipelineLayout = device
          .createPipelineLayout({ label: 'forward-ao-composite-pl', bindGroupLayouts: [layout] })
          .unwrap();
        const pipeline = device
          .createRenderPipeline({
            label: 'forward_ao_composite',
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs_main', buffers: [] },
            fragment: {
              module,
              entryPoint: 'fs_main',
              targets: [
                {
                  format: color.format,
                  // rgb = scene * visibility; the coverage lane stays untouched.
                  blend: {
                    color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' },
                    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                  },
                },
              ],
            },
            primitive: { topology: 'triangle-list' },
          })
          .unwrap();
        const sampler = device
          .createSampler({
            label: 'forward-ao-composite-sampler',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          })
          .unwrap();
        state = { pipeline, layout, sampler, groups: new WeakMap() };
      }
      const aoView = resources.textureView(ambientOcclusion.view).unwrap();
      const { layout, sampler } = state;
      const group = getOrCreateFromChain(
        state.groups,
        [aoView],
        'forward-ao-composite',
        () =>
          device
            .createBindGroup({
              label: 'forward-ao-composite-bg',
              layout,
              entries: [
                { binding: 0, resource: { kind: 'textureView' as const, value: aoView } },
                { binding: 1, resource: { kind: 'sampler' as const, value: sampler } },
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

/**
 * Forward SSAO/GTAO: reconstruct G-buffer-encoded world normals from the
 * opaque scene depth, run the same AO calc and depth/normal-aware filter as
 * the Deferred lane, then multiply the opaque scene by the filtered visibility
 * ahead of fog and translucency (Three r184 GTAOPass composition).
 */
export function addForwardAmbientOcclusion(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  scene: { readonly color: RenderPipelineTarget; readonly depth: RenderPipelineTarget },
  copySize: { readonly width: number; readonly height: number },
): Result<void, RenderGraphError> {
  if (topology.config?.ssao?.enabled !== true) return ok(undefined);
  if (scene.color.sampleCount !== 1 || scene.depth.sampleCount !== 1)
    return err(forwardAmbientOcclusionSampleCountError());
  const depthSample = graph.view(scene.depth.texture, {
    label: 'forward-ao-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depthSample.ok) return depthSample;
  const normal = createRenderPipelineTarget(graph, 'forward-ao-normal', {
    format: 'r32uint',
    size: copySize,
  });
  if (!normal.ok) return normal;
  const normalPass = addForwardAoNormalPass(graph, depthSample.value, normal.value);
  if (!normalPass.ok) return normalPass;
  const { resolutionScale } = getSsaoParameters(topology.config.ssao);
  const size = {
    width: Math.max(1, Math.round(copySize.width * resolutionScale)),
    height: Math.max(1, Math.round(copySize.height * resolutionScale)),
  };
  const raw = createRenderPipelineTarget(graph, 'ssao-raw', { format: 'rgba8unorm', size });
  if (!raw.ok) return raw;
  const blurred = createRenderPipelineTarget(graph, 'ssao-blurred', { format: 'r8unorm', size });
  if (!blurred.ok) return blurred;
  const passes = addTypedSsaoPasses(graph, {
    normal: normal.value,
    depth: scene.depth,
    raw: raw.value,
    blurred: blurred.value,
  });
  if (!passes.ok) return passes;
  return addForwardAoCompositePass(graph, blurred.value, scene.color);
}
