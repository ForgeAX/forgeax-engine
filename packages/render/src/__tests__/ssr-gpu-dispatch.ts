import { mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import gbufferSource from '../../../shader/src/standard-gbuffer.wgsl?raw';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { DepthPyramidShaderSources, SsrShaderSources } from '../render-contract';
import type { RenderPipelineFrame } from '../render-pipeline';
import { admitSsrSpatial } from '../ssr/admission';
import { addSsrCompositionPass } from '../ssr/compose';
import { addSsrSpatialPasses } from '../ssr/graph';

export const SSR_GPU_PROBE_WIDTH = 64;
export const SSR_GPU_PROBE_HEIGHT = 32;

// A perspective camera at the origin observes an inclined receiver x+z=-6
// and a red wall x=2. Both the depth and color producers use these same rays.
const SSR_TEST_SURFACES = /* wgsl */ `
fn surfaces(uv: vec2<f32>) -> vec2<f32> {
  let dx = (uv.x * 2.0 - 1.0) * 2.0 / 1.732050808;
  let receiver = select(20.0, 6.0 / max(1.0 - dx, 0.001), dx < 1.0);
  let wall = select(20.0, 2.0 / max(dx, 0.001), dx > 0.0);
  return vec2<f32>(min(min(receiver, wall), 20.0), select(0.0, 1.0, wall < receiver));
}
`;

const SSR_GPU_SCENE_SEED_WGSL = /* wgsl */ `
${SSR_TEST_SURFACES}
${gbufferSource.replace(/^#define_import_path[^\n]*\n/m, '')}
@group(0) @binding(0) var scene : texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var normal : texture_storage_2d<r32uint, write>;
@group(0) @binding(2) var fallback : texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var temporal : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn seed_ssr_scene(@builtin(global_invocation_id) id : vec3<u32>) {
  let size = textureDimensions(scene);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2<f32>(id.xy) + vec2<f32>(0.5)) / vec2<f32>(size);
  // A deterministic source/floor split makes a reflected sample observable
  // without introducing a second scene or material owner in the engine.
  let wall = surfaces(uv).y > 0.5;
  let source = select(vec3<f32>(0.04, 0.06, 0.08), vec3<f32>(0.9, 0.18, 0.04), wall);
  textureStore(scene, vec2<i32>(id.xy), vec4<f32>(source, 1.0));
  let receiverNormal = select(
    vec3<f32>(0.853553391, 0.50, 0.853553391),
    vec3<f32>(0.0, 0.50, 0.50),
    wall,
  );
  textureStore(normal, vec2<i32>(id.xy), vec4<u32>(encodeStandardNormalRoughness(receiverNormal * 2.0 - 1.0, select(0.1, 0.8, wall)), 0u, 0u, 0u));
  textureStore(fallback, vec2<i32>(id.xy), vec4<f32>(0.10, 0.10, 0.10, 1.0));
  textureStore(temporal, vec2<i32>(id.xy), vec4<f32>(0.0));
}
`;

const SSR_GPU_OCCLUDER_WGSL = /* wgsl */ `
${SSR_TEST_SURFACES}
@vertex
fn seed_ssr_occluder(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec4<f32>, 6>(
    vec4<f32>(-1.0, -1.0, 0.20, 1.0),
    vec4<f32>(1.0, -1.0, 0.20, 1.0),
    vec4<f32>(-1.0, 1.0, 0.20, 1.0),
    vec4<f32>(-1.0, 1.0, 0.20, 1.0),
    vec4<f32>(1.0, -1.0, 0.20, 1.0),
    vec4<f32>(1.0, 1.0, 0.20, 1.0),
  );
  return positions[index];
}
@fragment fn seed_ssr_depth(@builtin(position) pixel: vec4<f32>) -> @builtin(frag_depth) f32 {
  let z = surfaces(pixel.xy / vec2<f32>(${SSR_GPU_PROBE_WIDTH}.0, ${SSR_GPU_PROBE_HEIGHT}.0)).x;
  return 0.1 * (20.0 - z) / (19.9 * z);
}
`;

export interface SsrShaderManifest {
  readonly entries: readonly { readonly wgsl: string }[];
}

export interface SsrGpuDispatchOptions {
  /** Authoring maxDistance written through the shared View UBO. */
  readonly maxDistance?: number;
  /** Exercise the binary View-UBO enable sentinel without changing admission. */
  readonly enabled?: boolean;
  readonly sourceBackFacing?: boolean;
  readonly excludedSource?: boolean;
  readonly excludedReceiver?: boolean;
  readonly coordinateSource?: boolean;
  /** A recessed grout strip, not a painted line on a flat wall. */
  readonly recessedSource?: boolean;
}

function probeSurfaces(options: SsrGpuDispatchOptions) {
  return options.recessedSource
    ? SSR_TEST_SURFACES.replace(
        'let wall = select(20.0, 2.0 / max(dx, 0.001), dx > 0.0);',
        `let dy = (1.0 - uv.y * 2.0) / 1.732050808;
  let front = 2.0 / max(dx, 0.001);
  let wall = select(20.0, select(front, 2.12 / max(dx, 0.001), abs(dy * front) < 0.5), dx > 0.0);`,
      )
    : SSR_TEST_SURFACES;
}

/** SSR sources plus the depth-pyramid sources its trace reads. */
export type SsrProbeShaderSources = SsrShaderSources & DepthPyramidShaderSources;

export function sourcesFromManifest(manifest: SsrShaderManifest): SsrProbeShaderSources {
  const source = (entryPoint: string): string => {
    const entry = manifest.entries.find((candidate) =>
      candidate.wgsl.includes(`fn ${entryPoint}(`),
    );
    if (entry === undefined) throw new Error(`SSR manifest entry missing: ${entryPoint}`);
    return entry.wgsl;
  };
  return {
    seed: source('depth_pyramid_seed'),
    reduce: source('depth_pyramid_reduce'),
    trace: source('ssr_trace'),
    temporal: source('ssr_temporal'),
    compose: source('vs_ssr_compose'),
  };
}

/** Exact mirror/wall intersection independent of the production march. */
export function ssrCoordinateErrors(words: readonly number[], recessedSource = false) {
  const half = (value: number) => {
    const exponent = (value >> 10) & 31;
    return (
      (value & 0x8000 ? -1 : 1) *
      (exponent === 0
        ? (value & 1023) * 2 ** -24
        : (1 + (value & 1023) / 1024) * 2 ** (exponent - 15))
    );
  };
  const errors: number[] = [];
  for (let y = 0; y < SSR_GPU_PROBE_HEIGHT / 2; y++) {
    for (let x = 0; x < SSR_GPU_PROBE_WIDTH / 2; x++) {
      // The copy uses the full-width, 256-byte-aligned readback row stride.
      const p = (y * SSR_GPU_PROBE_WIDTH + x) * 4;
      if (half(words[p + 3] ?? 0) <= 0.2) continue;
      const dx = ((((x * 2 + 0.5) / SSR_GPU_PROBE_WIDTH) * 2 - 1) * 2) / Math.sqrt(3);
      const dy = (1 - ((y * 2 + 0.5) / SSR_GPU_PROBE_HEIGHT) * 2) / Math.sqrt(3);
      const z = 6 / (1 - dx);
      const wallX = recessedSource && Math.abs(dy * 8) < 0.5 ? 2.12 : 2;
      const targetDepth = z + dx * (wallX - dx * z);
      const u = 0.5 + (wallX * Math.sqrt(3)) / targetDepth / 4;
      const v = 0.5 - (((dy * (6 + wallX)) / targetDepth) * Math.sqrt(3)) / 2;
      if (u < 0.15 || u > 0.85 || v < 0.15 || v > 0.85) continue;
      // Integrate the finite wall's UV ramp over the bilinear footprint.
      // The adjoining receiver faces away from the reflected ray and must
      // not contribute its brown color. Interior footprints reproduce (u,v).
      const px = u * SSR_GPU_PROBE_WIDTH - 0.5;
      const py = v * SSR_GPU_PROBE_HEIGHT - 0.5;
      const fx = px - Math.floor(px),
        fy = py - Math.floor(py);
      let expectedU = 0,
        expectedV = 0,
        coverage = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const su = (Math.floor(px) + sx + 0.5) / SSR_GPU_PROBE_WIDTH;
          const sv = (Math.floor(py) + sy + 0.5) / SSR_GPU_PROBE_HEIGHT;
          const sdx = ((su * 2 - 1) * 2) / Math.sqrt(3);
          const sdy = (1 - sv * 2) / Math.sqrt(3);
          const front = sdx > 0 ? 2 / sdx : 20;
          const sourceWall = recessedSource && Math.abs(sdy * front) < 0.5 ? 2.12 / sdx : front;
          const sourceReceiver = sdx < 1 ? 6 / (1 - sdx) : 20;
          if (sourceWall >= Math.min(sourceReceiver, 20)) continue;
          const weight = (sx ? fx : 1 - fx) * (sy ? fy : 1 - fy);
          expectedU += su * weight;
          expectedV += sv * weight;
          coverage += weight;
        }
      if (coverage <= 0) {
        errors.push(Number.POSITIVE_INFINITY);
        continue;
      }
      errors.push(
        Math.max(
          Math.abs(half(words[p] ?? 0) - expectedU / coverage),
          Math.abs(half(words[p + 1] ?? 0) - expectedV / coverage),
        ),
      );
    }
  }
  return errors;
}

/** Execute the production ray-depth function with genuine camera projections. */
export async function runSsrViewDistanceProbe(device: RhiDevice, source: string) {
  const module = createShaderModuleImmediate(device, {
    code: `${source}
@group(1) @binding(0) var<storage, read_write> depthProbe : array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_ssr_view_distance() {
  depthProbe[0] = vec4<f32>(
    projectWorldViewDistance(vec3<f32>(0.0, 0.0, -6.58)),
    projectWorldViewDistance(vec3<f32>(0.0, 0.0, -12.0)), 0.0, 0.0);
}`,
  }).unwrap();
  const viewLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 5, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } }],
    })
    .unwrap();
  const resultLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } }],
    })
    .unwrap();
  const layout = device
    .createPipelineLayout({ bindGroupLayouts: [viewLayout, resultLayout] })
    .unwrap();
  const pipeline = device
    .createComputePipeline({ layout, compute: { module, entryPoint: 'probe_ssr_view_distance' } })
    .unwrap();
  const view = device
    .createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const output = device
    .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC })
    .unwrap();
  const readback = device
    .createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  try {
    const viewGroup = device
      .createBindGroup({
        layout: viewLayout,
        entries: [{ binding: 5, resource: { kind: 'buffer', value: { buffer: view } } }],
      })
      .unwrap();
    const outputGroup = device
      .createBindGroup({
        layout: resultLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
      })
      .unwrap();
    const samples: number[][] = [];
    for (const orthographic of [false, true]) {
      const projection = mat4.create();
      if (orthographic) mat4.orthographicReverseZ(projection, -4, 4, 4, -4, 0.1, 20);
      else mat4.perspectiveReverseZ(projection, Math.PI / 3, 1, 0.1, 20);
      const payload = new Float32Array(VIEW_UNIFORM_BYTES / 4);
      payload.set(projection);
      payload.set([0.1, 20, Number(orthographic), 0], 228);
      device.queue.writeBuffer(view, 0, payload).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, viewGroup);
      pass.setBindGroup(1, outputGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
      samples.push([...new Float32Array(mapped.getMappedRange().unwrap().slice(0))]);
      mapped.unmap();
    }
    return samples;
  } finally {
    device.destroyBuffer(view).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
}

export function admittedSsrSpatial() {
  return admitSsrSpatial({
    camera: {
      projection: 'perspective',
      near: 0.1,
      far: 100,
      screenSpaceReflection: { maxDistance: 40, thickness: 0.2, maxRoughness: 0.6 },
    },
    environment: {
      lane: 'deferred',
      m0: { status: 'admitted' },
      sceneInputs: true,
      temporal: true,
      reflectionFallback: true,
      capabilities: {
        compute: true,
        storageTexture: true,
        rgba16floatRenderable: true,
        r32floatSampledStorage: true,
      },
    },
  });
}

function runtimeFor(device: RhiDevice) {
  return {
    device,
    shaderModuleFactory: {
      createShaderModule: (descriptor: { readonly code: string; readonly label?: string }) =>
        createShaderModuleImmediate(device, descriptor),
    },
    errorRegistry: {
      fire: (error: unknown): void => {
        throw error;
      },
    },
  };
}

function seedSceneState(device: RhiDevice, options: SsrGpuDispatchOptions) {
  let source = SSR_GPU_SCENE_SEED_WGSL.replace(SSR_TEST_SURFACES, probeSurfaces(options));
  if (options.coordinateSource)
    source = source.replace('vec3<f32>(0.9, 0.18, 0.04)', 'vec3<f32>(uv, 0.5)');
  if (options.sourceBackFacing)
    source = source.replace('vec3<f32>(0.0, 0.50, 0.50)', 'vec3<f32>(1.0, 0.50, 0.50)');
  if (options.excludedSource)
    source = source.replace(
      'vec4<f32>(0.10, 0.10, 0.10, 1.0)',
      'vec4<f32>(0.10, 0.10, 0.10, select(1.0, 0.0, wall))',
    );
  if (options.excludedReceiver)
    source = source.replace(
      'vec4<f32>(0.10, 0.10, 0.10, 1.0)',
      'vec4<f32>(0.10, 0.10, 0.10, select(0.0, 1.0, wall))',
    );
  const module = createShaderModuleImmediate(device, {
    code: source,
    label: 'ssr-scene-seed',
  });
  if (!module.ok) throw module.error;
  const layout = device
    .createBindGroupLayout({
      label: 'ssr-scene-seed.bind-group-layout',
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'r32uint', viewDimension: '2d' },
        },
        {
          binding: 2,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
        {
          binding: 3,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
      ],
    })
    .unwrap();
  const pipelineLayout = device
    .createPipelineLayout({ label: 'ssr-scene-seed.pipeline-layout', bindGroupLayouts: [layout] })
    .unwrap();
  const pipeline = device
    .createComputePipeline({
      label: 'ssr-scene-seed',
      layout: pipelineLayout,
      compute: { module: module.value, entryPoint: 'seed_ssr_scene' },
    })
    .unwrap();
  return { layout, pipeline };
}

function seedOccluderPipeline(device: RhiDevice, options: SsrGpuDispatchOptions) {
  const module = createShaderModuleImmediate(device, {
    code: SSR_GPU_OCCLUDER_WGSL.replace(SSR_TEST_SURFACES, probeSurfaces(options)),
    label: 'ssr-occluder-seed',
  });
  if (!module.ok) throw module.error;
  return device
    .createRenderPipeline({
      label: 'ssr-occluder-seed',
      layout: 'auto',
      vertex: { module: module.value, entryPoint: 'seed_ssr_occluder', buffers: [] },
      fragment: { module: module.value, entryPoint: 'seed_ssr_depth', targets: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth32float-stencil8',
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    })
    .unwrap();
}

/** Run repeated actual SSR graph dispatches and read back the scene and traced radiance. */
export async function runSsrGpuDispatch(
  device: RhiDevice,
  shaders: SsrProbeShaderSources,
  frameCount = 1,
  options: SsrGpuDispatchOptions = {},
) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const depthTexture = graph
    .createTexture('scene-depth', {
      format: 'depth32float-stencil8',
      size: { width: SSR_GPU_PROBE_WIDTH, height: SSR_GPU_PROBE_HEIGHT },
    })
    .unwrap();
  const depthSample = graph
    .view(depthTexture, {
      label: 'scene-depth.sample',
      dimension: '2d',
      aspect: 'depth-only',
    })
    .unwrap();
  const depthAttachment = graph
    .view(depthTexture, {
      label: 'scene-depth.attachment',
      dimension: '2d',
      aspect: 'all',
    })
    .unwrap();
  const color = (
    label: string,
    extent = { width: SSR_GPU_PROBE_WIDTH, height: SSR_GPU_PROBE_HEIGHT },
    format: 'rgba16float' | 'rgba8unorm' | 'r32uint' = 'rgba16float',
  ) => {
    const texture = graph
      .createTexture(label, {
        format,
        size: extent,
      })
      .unwrap();
    const view = graph.view(texture, { label: `${label}.view` }).unwrap();
    return { texture, view };
  };
  const normal = color('gbuffer-normal', undefined, 'r32uint');
  const response = color('gbuffer-response');
  const scene = color('scene-color');
  const fallback = color('reflection-fallback');
  const currentTemporal = color('scene-temporal');
  const viewUniformBuffer = device
    .createBuffer({
      label: 'ssr-view',
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const viewPayload = new Float32Array(VIEW_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
  const projection = mat4.create();
  mat4.perspectiveReverseZ(projection, Math.PI / 3, 2, 0.1, 20);
  const inverseProjection = mat4.create();
  mat4.invert(inverseProjection, projection);
  viewPayload.set(projection, 0);
  viewPayload.set(inverseProjection, 44);
  viewPayload.set(projection, 196);
  viewPayload.set(projection, 212);
  // The depth-pyramid seed linearizes the depth attachment through the shared View
  // projection range; keep this carrier's identity matrices paired with the
  // same finite perspective range used by the admission fixture.
  viewPayload[228] = 0.1;
  viewPayload[229] = 20;
  viewPayload[230] = 0;
  viewPayload[236] = options.maxDistance ?? 12;
  viewPayload[237] = 0.2;
  viewPayload[238] = 0.6;
  viewPayload[239] = options.enabled === false ? 0 : 1;
  const wroteView = device.queue.writeBuffer(viewUniformBuffer, 0, viewPayload);
  if (!wroteView.ok) throw wroteView.error;
  const view = graph
    .importBuffer(
      'ssr-view',
      { size: VIEW_UNIFORM_BYTES, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
      () => viewUniformBuffer,
    )
    .unwrap();
  const halfExtent = {
    width: Math.max(1, Math.floor(SSR_GPU_PROBE_WIDTH / 2)),
    height: Math.max(1, Math.floor(SSR_GPU_PROBE_HEIGHT / 2)),
  };
  const previousHistory = color('ssr-history-previous', halfExtent);
  const outputHistory = color('ssr-history-output', halfExtent);
  const previousSurface = color('ssr-history-previous-surface', halfExtent, 'rgba8unorm');
  const outputSurface = color('ssr-history-output-surface', halfExtent, 'rgba8unorm');
  const seed = graph.addRasterPass('seed-inputs', {
    accesses: [
      { resource: depthAttachment, usage: 'depth-stencil-write' },
      { resource: normal.view, usage: 'color-attachment' },
      { resource: scene.view, usage: 'color-attachment' },
      { resource: fallback.view, usage: 'color-attachment' },
      { resource: currentTemporal.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: normal.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.5, g: 0.5, b: 1, a: 0.2 },
      },
      {
        view: scene.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.4, g: 0.2, b: 0.1, a: 0.2 },
      },
      {
        view: fallback.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 0 },
      },
      {
        view: currentTemporal.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    depthStencilAttachment: {
      view: depthAttachment,
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      stencilClearValue: 0,
      stencilLoadOp: 'clear',
      stencilStoreOp: 'store',
    },
    encode: () => undefined,
  });
  if (!seed.ok) throw seed.error;
  let occluderPipeline: ReturnType<typeof seedOccluderPipeline> | undefined;
  const occluder = graph.addRasterPass('seed-ssr-occluder', {
    accesses: [{ resource: depthAttachment, usage: 'depth-stencil-write' }],
    colorAttachments: [],
    depthStencilAttachment: {
      view: depthAttachment,
      depthLoadOp: 'load',
      depthStoreOp: 'store',
      stencilLoadOp: 'load',
      stencilStoreOp: 'store',
    },
    encode: ({ pass }) => {
      occluderPipeline ??= seedOccluderPipeline(device, options);
      pass.setPipeline(occluderPipeline);
      pass.draw(6, 1, 0, 0);
    },
  });
  if (!occluder.ok) throw occluder.error;
  let sceneSeedState: ReturnType<typeof seedSceneState> | undefined;
  const seededScene = graph.addComputePass('seed-ssr-scene-pattern', {
    accesses: [
      { resource: scene.view, usage: 'storage-write' },
      { resource: normal.view, usage: 'storage-write' },
      { resource: fallback.view, usage: 'storage-write' },
      { resource: currentTemporal.view, usage: 'storage-write' },
    ],
    encode: ({ pass, frame, resources: resolver }) => {
      sceneSeedState ??= seedSceneState(device, options);
      const bindGroup = device
        .createBindGroup({
          layout: sceneSeedState.layout,
          entries: [
            {
              binding: 0,
              resource: { kind: 'textureView', value: resolver.textureView(scene.view).unwrap() },
            },
            {
              binding: 1,
              resource: { kind: 'textureView', value: resolver.textureView(normal.view).unwrap() },
            },
            {
              binding: 2,
              resource: {
                kind: 'textureView',
                value: resolver.textureView(fallback.view).unwrap(),
              },
            },
            {
              binding: 3,
              resource: {
                kind: 'textureView',
                value: resolver.textureView(currentTemporal.view).unwrap(),
              },
            },
          ],
        })
        .unwrap();
      pass.setPipeline(sceneSeedState.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(SSR_GPU_PROBE_WIDTH / 8),
        Math.ceil(SSR_GPU_PROBE_HEIGHT / 8),
        1,
      );
      void frame;
    },
  });
  if (!seededScene.ok) throw seededScene.error;
  const responseSeed = graph.addRasterPass('seed-ssr-response', {
    accesses: [{ resource: response.view, usage: 'color-attachment' }],
    colorAttachments: [
      {
        view: response.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
      },
    ],
    encode: () => undefined,
  });
  if (!responseSeed.ok) throw responseSeed.error;
  const historySeed = graph.addRasterPass('seed-ssr-history', {
    accesses: [
      { resource: previousHistory.view, usage: 'color-attachment' },
      { resource: outputHistory.view, usage: 'color-attachment' },
      { resource: previousSurface.view, usage: 'color-attachment' },
      { resource: outputSurface.view, usage: 'color-attachment' },
    ],
    colorAttachments: [
      {
        view: previousHistory.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.3, g: 0.2, b: 0.1, a: 0.5 },
      },
      {
        view: outputHistory.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
      {
        view: previousSurface.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.5, g: 0.5, b: 1, a: 1 },
      },
      {
        view: outputSurface.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
    encode: () => undefined,
  });
  if (!historySeed.ok) throw historySeed.error;
  const temporalParamsBuffer = device
    .createBuffer({
      label: 'ssr-temporal-params',
      size: 32,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const temporalParamsData = new ArrayBuffer(32);
  const temporalParamsView = new DataView(temporalParamsData);
  temporalParamsView.setUint32(0, 1, true);
  temporalParamsView.setFloat32(4, 0.9, true);
  temporalParamsView.setFloat32(8, 0.1, true);
  temporalParamsView.setFloat32(12, 0.5, true);
  const wroteTemporalParams = device.queue.writeBuffer(
    temporalParamsBuffer,
    0,
    new Uint8Array(temporalParamsData),
  );
  if (!wroteTemporalParams.ok) throw wroteTemporalParams.error;
  const temporalParams = graph
    .importBuffer(
      'ssr-temporal-params',
      { size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
      () => temporalParamsBuffer,
    )
    .unwrap();
  const depthPyramid = addDepthPyramidPasses(graph, {
    depth: depthSample,
    width: SSR_GPU_PROBE_WIDTH,
    height: SSR_GPU_PROBE_HEIGHT,
    view,
  });
  if (!depthPyramid.ok) throw depthPyramid.error;
  const pyramid = depthPyramid.value.pyramid;
  const projected = addSsrSpatialPasses(graph, {
    admission: admittedSsrSpatial(),
    width: SSR_GPU_PROBE_WIDTH,
    height: SSR_GPU_PROBE_HEIGHT,
    depth: depthSample,
    normal: normal.view,
    scene: scene.view,
    fallback: fallback.view,
    currentTemporal: currentTemporal.view,
    view,
    depthPyramid: pyramid,
    temporal: {
      previousHistory: previousHistory.view,
      outputHistory: outputHistory.view,
      previousSurface: previousSurface.view,
      outputSurface: outputSurface.view,
      params: temporalParams,
    },
  });
  if (!projected.ok) throw projected.error;
  const resources = projected.value.resources;
  if (resources === undefined) throw new Error('SSR spatial resources missing');
  addSsrCompositionPass(graph, {
    scene: { ...scene, format: 'rgba16float', sampleCount: 1 },
    radiance: resources.radiancePyramid ?? resources.trace.view,
    fallback: fallback.view,
    response: response.view,
    normal: normal.view,
    view,
  }).unwrap();

  const bytesPerRow = Math.ceil((SSR_GPU_PROBE_WIDTH * 8) / 256) * 256;
  const readbackBuffer = device
    .createBuffer({
      label: 'ssr-readback',
      size: bytesPerRow * SSR_GPU_PROBE_HEIGHT,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const traceReadbackBuffer = device
    .createBuffer({
      label: 'ssr-trace-readback',
      size: bytesPerRow * Math.max(1, Math.floor(SSR_GPU_PROBE_HEIGHT / 2)),
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const pyramidReadbackBuffer = device
    .createBuffer({
      label: 'depth-pyramid-readback',
      size: bytesPerRow * SSR_GPU_PROBE_HEIGHT,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const readback = graph
    .importBuffer(
      'ssr-readback',
      {
        size: bytesPerRow * SSR_GPU_PROBE_HEIGHT,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      },
      () => readbackBuffer,
    )
    .unwrap();
  const copy = graph.addCopyPass('ssr-readback', {
    accesses: [
      { resource: scene.view, usage: 'copy-src' },
      { resource: readback, usage: 'copy-dst' },
    ],
    encode: ({ encoder, resources: resolver }) => {
      encoder.copyTextureToBuffer(
        { texture: resolver.texture(scene.texture).unwrap() as never },
        {
          buffer: resolver.buffer(readback).unwrap() as never,
          bytesPerRow,
          rowsPerImage: SSR_GPU_PROBE_HEIGHT,
        },
        {
          width: SSR_GPU_PROBE_WIDTH,
          height: SSR_GPU_PROBE_HEIGHT,
          depthOrArrayLayers: 1,
        },
      );
    },
  });
  if (!copy.ok) throw copy.error;
  const traceReadback = graph
    .importBuffer(
      'ssr-trace-readback',
      {
        size: bytesPerRow * Math.max(1, Math.floor(SSR_GPU_PROBE_HEIGHT / 2)),
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      },
      () => traceReadbackBuffer,
    )
    .unwrap();
  const traceCopy = graph.addCopyPass('ssr-trace-readback', {
    accesses: [
      { resource: resources.trace.view, usage: 'copy-src' },
      { resource: traceReadback, usage: 'copy-dst' },
    ],
    encode: ({ encoder, resources: resolver }) => {
      encoder.copyTextureToBuffer(
        { texture: resolver.texture(resources.trace.texture).unwrap() as never },
        {
          buffer: resolver.buffer(traceReadback).unwrap() as never,
          bytesPerRow,
          rowsPerImage: Math.max(1, Math.floor(SSR_GPU_PROBE_HEIGHT / 2)),
        },
        {
          width: Math.max(1, Math.floor(SSR_GPU_PROBE_WIDTH / 2)),
          height: Math.max(1, Math.floor(SSR_GPU_PROBE_HEIGHT / 2)),
          depthOrArrayLayers: 1,
        },
      );
    },
  });
  if (!traceCopy.ok) throw traceCopy.error;
  const pyramidReadback = graph
    .importBuffer(
      'depth-pyramid-readback',
      {
        size: bytesPerRow * SSR_GPU_PROBE_HEIGHT,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      },
      () => pyramidReadbackBuffer,
    )
    .unwrap();
  const pyramidLevel0 = pyramid.levels[0];
  if (pyramidLevel0 === undefined) throw new Error('depth pyramid mip 0 missing');
  const pyramidCopy = graph.addCopyPass('depth-pyramid-readback', {
    accesses: [
      { resource: pyramidLevel0, usage: 'copy-src' },
      { resource: pyramidReadback, usage: 'copy-dst' },
    ],
    encode: ({ encoder, resources: resolver }) => {
      encoder.copyTextureToBuffer(
        { texture: resolver.texture(pyramid.texture).unwrap() as never },
        {
          buffer: resolver.buffer(pyramidReadback).unwrap() as never,
          bytesPerRow,
          rowsPerImage: pyramid.plan.extent.height,
        },
        {
          width: pyramid.plan.extent.width,
          height: pyramid.plan.extent.height,
          depthOrArrayLayers: 1,
        },
      );
    },
  });
  if (!pyramidCopy.ok) throw pyramidCopy.error;
  const surfaceReadbackBuffer = device
    .createBuffer({
      size: bytesPerRow * halfExtent.height,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const surfaceReadback = graph
    .importBuffer(
      'ssr-surface-readback',
      {
        size: bytesPerRow * halfExtent.height,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      },
      () => surfaceReadbackBuffer,
    )
    .unwrap();
  graph
    .addCopyPass('ssr-surface-readback', {
      accesses: [
        { resource: outputSurface.view, usage: 'copy-src' },
        { resource: surfaceReadback, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources: resolver }) => {
        encoder.copyTextureToBuffer(
          { texture: resolver.texture(outputSurface.texture).unwrap() as never },
          {
            buffer: resolver.buffer(surfaceReadback).unwrap() as never,
            bytesPerRow,
            rowsPerImage: halfExtent.height,
          },
          { width: halfExtent.width, height: halfExtent.height, depthOrArrayLayers: 1 },
        );
      },
    })
    .unwrap();
  const compiled = graph
    .compile({
      device,
      surfaceSize: { width: SSR_GPU_PROBE_WIDTH, height: SSR_GPU_PROBE_HEIGHT },
    })
    .unwrap();
  const pixels: number[][] = [];
  const tracePixels: number[][] = [];
  const pyramidPixels: number[][] = [];
  let surfacePixels: number[] = [];
  const bindGroupCounts = { createBindGroup: 0, keys: [] as string[] };
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const encoder = device.createCommandEncoder({ label: `ssr-gpu-probe-${frameIndex}` }).unwrap();
    const frame = {
      encoder,
      runtime: runtimeFor(device),
      ssrShaders: { trace: shaders.trace, temporal: shaders.temporal, compose: shaders.compose },
      depthPyramidShaders: { seed: shaders.seed, reduce: shaders.reduce },
      bindGroupCounts,
    } as unknown as RenderPipelineFrame;
    const executed = compiled.execute(frame);
    if (!executed.ok) throw executed.error;
    if (frameIndex === 1) bindGroupCounts.createBindGroup = 0;
    if (frameIndex > 1 && bindGroupCounts.createBindGroup !== 0) {
      throw new Error('Stable SSR dispatch recreated a bind group');
    }
    const finished = encoder.finish();
    if (!finished.ok) throw finished.error;
    const submitted = device.queue.submit([finished.value]);
    if (!submitted.ok) throw submitted.error;
    await device.queue.onSubmittedWorkDone();
    // These independent copies share one completed submission. Request all
    // mappings together instead of paying three browser/driver round trips
    // for each of the 60 frames; every buffer is still read and validated.
    const [mapped, traceMapped, pyramidMapped] = await Promise.all([
      readbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ),
      traceReadbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ),
      pyramidReadbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ),
    ]);
    if (!mapped.ok) throw mapped.error;
    if (!traceMapped.ok) throw traceMapped.error;
    if (!pyramidMapped.ok) throw pyramidMapped.error;
    const range = mapped.value.getMappedRange();
    if (!range.ok) throw range.error;
    const readbackWords = new Uint16Array(range.value.slice(0, bytesPerRow * SSR_GPU_PROBE_HEIGHT));
    pixels.push([...readbackWords.slice(0, 4)]);
    mapped.value.unmap();
    const traceRange = traceMapped.value.getMappedRange();
    if (!traceRange.ok) throw traceRange.error;
    const traceWords = new Uint16Array(
      traceRange.value.slice(0, bytesPerRow * Math.max(1, Math.floor(SSR_GPU_PROBE_HEIGHT / 2))),
    );
    tracePixels.push([...traceWords]);
    traceMapped.value.unmap();
    const pyramidRange = pyramidMapped.value.getMappedRange();
    if (!pyramidRange.ok) throw pyramidRange.error;
    const pyramidWords = new Float32Array(
      pyramidRange.value.slice(0, bytesPerRow * SSR_GPU_PROBE_HEIGHT),
    );
    const pyramidRowStride = bytesPerRow / Float32Array.BYTES_PER_ELEMENT;
    const pyramidFrame: number[] = [];
    for (let y = 0; y < pyramid.plan.extent.height; y += 1) {
      pyramidFrame.push(
        ...pyramidWords.slice(
          y * pyramidRowStride,
          y * pyramidRowStride + pyramid.plan.extent.width,
        ),
      );
    }
    pyramidPixels.push(pyramidFrame);
    pyramidMapped.value.unmap();
    if (frameIndex === frameCount - 1) {
      const mapped = (await surfaceReadbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
      const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
      surfacePixels = Array.from({ length: halfExtent.height }, (_, y) => [
        ...bytes.slice(y * bytesPerRow, y * bytesPerRow + halfExtent.width * 4),
      ]).flat();
      mapped.unmap();
    }
  }
  const info = compiled.inspect();
  (await compiled.retire()).unwrap();
  device.destroyBuffer(readbackBuffer).unwrap();
  device.destroyBuffer(traceReadbackBuffer).unwrap();
  device.destroyBuffer(pyramidReadbackBuffer).unwrap();
  device.destroyBuffer(surfaceReadbackBuffer).unwrap();
  device.destroyBuffer(temporalParamsBuffer).unwrap();
  device.destroyBuffer(viewUniformBuffer).unwrap();
  return {
    pixel: pixels[0] ?? [],
    pixels: Object.freeze(pixels),
    tracePixels: Object.freeze(tracePixels),
    pyramidPixels: Object.freeze(pyramidPixels),
    surfacePixels: Object.freeze(surfacePixels),
    passNames: info.passes.map((pass) => pass.name),
    resourceNames: info.resources.map((resource) => resource.label),
  };
}
