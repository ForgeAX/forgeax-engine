import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mat4 } from '@forgeax/engine-math';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import { gbufferSource } from './standard-gbuffer.fixture';

it('descends a real depth-pyramid seed and preserves all four non-center source texels', async () => {
  const compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as {
    compileShader(
      source: string,
      options: { id: string; imports: Record<string, string> },
    ): Promise<{ ok: boolean; value?: { wgsl: string }; error?: unknown }>;
  };
  const shader = (name: string) =>
    readFileSync(resolve(process.cwd(), `packages/shader/src/${name}.wgsl`), 'utf8');
  const common = {
    'forgeax_view::common': shader('common'),
    'forgeax_pbr::gbuffer': gbufferSource,
    'forgeax_depth_pyramid::sample': shader('depth-pyramid-sample'),
  };
  const trace = await compiler.compileShader(
    `${shader('ssr-trace')}
@group(1) @binding(0) var<storage, read_write> rescueProbe: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_rescue() {
  let fullSize = vec2<u32>(4u, 4u);
  let startUv = vec2<f32>(0.0);
  let deltaUv = vec2<f32>(1.0);
  let fallback = 0.0;
  let endFraction = 1.0;
  let a = locateSsrPyramidCandidate(vec2<f32>(0.25, 0.25), 1u, fullSize,
    startUv, deltaUv, fallback, endFraction);
  let b = locateSsrPyramidCandidate(vec2<f32>(0.75, 0.25), 1u, fullSize,
    startUv, deltaUv, fallback, endFraction);
  let c = locateSsrPyramidCandidate(vec2<f32>(0.25, 0.75), 1u, fullSize,
    startUv, deltaUv, fallback, endFraction);
  let d = locateSsrPyramidCandidate(vec2<f32>(0.75, 0.75), 1u, fullSize,
    startUv, deltaUv, fallback, endFraction);
  rescueProbe[0] = vec4<f32>(select(0.0, 1.0, a.valid), vec2<f32>(a.pixel), a.fraction);
  rescueProbe[1] = vec4<f32>(select(0.0, 1.0, b.valid), vec2<f32>(b.pixel), b.fraction);
  rescueProbe[2] = vec4<f32>(select(0.0, 1.0, c.valid), vec2<f32>(c.pixel), c.fraction);
  rescueProbe[3] = vec4<f32>(select(0.0, 1.0, d.valid), vec2<f32>(d.pixel), d.fraction);
  let valid = ssrRescueCandidateInRay(vec3<f32>(0.0, 0.0, -1.0),
    vec3<f32>(0.0, 0.0, -1.0), 2.0, vec3<f32>(0.0, 0.0, -2.0),
    vec3<f32>(0.0, 0.0, 1.0), fullSize, vec2<u32>(2u, 2u));
  let behind = ssrRescueCandidateInRay(vec3<f32>(0.0, 0.0, -2.0),
    vec3<f32>(1.0, 0.0, 0.0), 2.0, vec3<f32>(-1.0, 0.0, -2.0),
    vec3<f32>(1.0, 0.0, 0.0), fullSize, vec2<u32>(1u, 2u));
  let beyond = ssrRescueCandidateInRay(vec3<f32>(0.0, 0.0, -1.0),
    vec3<f32>(0.0, 0.0, -1.0), 2.0, vec3<f32>(0.0, 0.0, -4.0),
    vec3<f32>(0.0, 0.0, 1.0), fullSize, vec2<u32>(2u, 2u));
  let silhouette = ssrRescueCandidateInRay(vec3<f32>(0.0, 0.0, -1.0),
    vec3<f32>(0.0, 0.0, -1.0), 2.0, vec3<f32>(1.0, 0.0, -2.0),
    vec3<f32>(0.0, 0.0, 1.0), fullSize, vec2<u32>(3u, 2u));
  rescueProbe[4] = vec4<f32>(select(0.0, 1.0, valid), select(0.0, 1.0, behind),
    select(0.0, 1.0, beyond), select(0.0, 1.0, silhouette));
}`,
    { id: 'forgeax_ssr::pyramid-rescue-trace', imports: common },
  );
  if (!trace.ok || !trace.value) throw new Error(JSON.stringify(trace.error));
  const pyramid = await compiler.compileShader(shader('depth-pyramid-seed'), {
    id: 'forgeax_depth_pyramid::rescue-seed',
    imports: common,
  });
  if (!pyramid.ok || !pyramid.value) throw new Error(JSON.stringify(pyramid.error));

  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const depth = device
    .createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      format: 'depth32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const pyramidTexture = device
    .createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      format: 'r32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const view = device
    .createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const output = device
    .createBuffer({
      size: 128,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    })
    .unwrap();
  const readback = device
    .createBuffer({
      size: 128,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  try {
    const projection = mat4.create();
    const inverse = mat4.create();
    mat4.perspectiveReverseZ(projection, Math.PI / 2, 1, 1, 10);
    mat4.invert(inverse, projection);
    const payload = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    payload.set(projection, 0);
    payload.set(inverse, 44);
    payload.set([1, 10, 0, 0], 228);
    device.queue.writeBuffer(view, 0, payload).unwrap();

    const depthSeed = createShaderModuleImmediate(device, {
      code: `
@vertex fn seed_vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn seed_depth(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
  let x = u32(p.x);
  let y = u32(p.y);
  // One valid source occupies a different non-center position in every 2x2
  // full-resolution footprint; the other three positions remain sky.
  let source = (x == 0u && y == 0u) || (x == 3u && y == 0u) ||
    (x == 0u && y == 3u) || (x == 2u && y == 2u);
  return select(0.0, 0.5, source);
}`,
    }).unwrap();
    const depthSeedPipeline = device
      .createRenderPipeline({
        layout: 'auto',
        vertex: { module: depthSeed, entryPoint: 'seed_vertex', buffers: [] },
        fragment: { module: depthSeed, entryPoint: 'seed_depth', targets: [] },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      })
      .unwrap();

    const pyramidSeedModule = createShaderModuleImmediate(device, {
      code: pyramid.value.wgsl,
    }).unwrap();
    const pyramidSeedLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'depth', viewDimension: '2d' },
          },
          {
            binding: 1,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
          },
          { binding: 2, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const pyramidSeedPipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [pyramidSeedLayout] }).unwrap(),
        compute: { module: pyramidSeedModule, entryPoint: 'depth_pyramid_seed' },
      })
      .unwrap();

    const traceModule = createShaderModuleImmediate(device, { code: trace.value.wgsl }).unwrap();
    const traceInputLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'depth', viewDimension: '2d' },
          },
          {
            binding: 3,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
          { binding: 5, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const traceOutputLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const tracePipeline = device
      .createComputePipeline({
        layout: device
          .createPipelineLayout({ bindGroupLayouts: [traceInputLayout, traceOutputLayout] })
          .unwrap(),
        compute: { module: traceModule, entryPoint: 'probe_rescue' },
      })
      .unwrap();

    const depthView = device.createTextureView(depth, {}).unwrap();
    const pyramidView = device.createTextureView(pyramidTexture, {}).unwrap();
    const pyramidSeedGroup = device
      .createBindGroup({
        layout: pyramidSeedLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: depthView } },
          { binding: 1, resource: { kind: 'textureView', value: pyramidView } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: view } } },
        ],
      })
      .unwrap();
    const traceInputGroup = device
      .createBindGroup({
        layout: traceInputLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: depthView } },
          { binding: 3, resource: { kind: 'textureView', value: pyramidView } },
          { binding: 5, resource: { kind: 'buffer', value: { buffer: view } } },
        ],
      })
      .unwrap();
    const traceOutputGroup = device
      .createBindGroup({
        layout: traceOutputLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
      })
      .unwrap();

    const encoder = device.createCommandEncoder().unwrap();
    const raster = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    raster.setPipeline(depthSeedPipeline);
    raster.draw(3);
    raster.end();
    const seedPass = encoder.beginComputePass();
    seedPass.setPipeline(pyramidSeedPipeline);
    seedPass.setBindGroup(0, pyramidSeedGroup);
    seedPass.dispatchWorkgroups(1);
    seedPass.end();
    const tracePass = encoder.beginComputePass();
    tracePass.setPipeline(tracePipeline);
    tracePass.setBindGroup(0, traceInputGroup);
    tracePass.setBindGroup(1, traceOutputGroup);
    tracePass.dispatchWorkgroups(1);
    tracePass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 128);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const values = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();

    // Each result is [valid, source-x, source-y, ray-fraction]. The selected
    // texel must be the actual seed owner, never the footprint center.
    expect(Array.from(values).slice(0, 20)).toEqual([
      1, 0, 0, 0.125, 1, 3, 0, 0.875, 1, 0, 3, 0.125, 1, 2, 2, 0.625, 1, 0, 0, 0,
    ]);
  } finally {
    device.destroyTexture(depth).unwrap();
    device.destroyTexture(pyramidTexture).unwrap();
    for (const buffer of [view, output, readback]) device.destroyBuffer(buffer).unwrap();
  }
});
