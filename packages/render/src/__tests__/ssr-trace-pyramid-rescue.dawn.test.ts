import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mat4 } from '@forgeax/engine-math';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
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
import { gbufferSource, writePackedNormals } from './standard-gbuffer.fixture';

// The trace no longer promotes a pyramid candidate ("rescue") to a hit. A
// closest-depth cell only proves that some texel in its footprint may be
// crossed; the Hi-Z descent must reach the actual source texel at full
// resolution and reject the empty texels that share its footprint.
const SOURCES = [
  [0, 0],
  [3, 0],
  [0, 3],
  [2, 2],
] as const;
// Empty texels whose 2x2 footprint holds a source: (1,0) shares (0,0), (3,1) shares (3,0).
const EMPTY = [
  [1, 0],
  [3, 1],
] as const;
const SOURCE_DEPTH = 0.5;
// Reverse-Z, near 1, far 10: depth = (10 / viewDistance - 1) / 9.
const SOURCE_VIEW_DISTANCE = 10 / (1 + 9 * SOURCE_DEPTH);
// A receiver inside texel (1,1), at view distance 1.
const ORIGIN = [-0.2, 0.2, -1] as const;

function texelCenterWorld([x, y]: readonly [number, number]): [number, number, number] {
  const ndcX = ((x + 0.5) / 4) * 2 - 1;
  const ndcY = 1 - ((y + 0.5) / 4) * 2;
  return [ndcX * SOURCE_VIEW_DISTANCE, ndcY * SOURCE_VIEW_DISTANCE, -SOURCE_VIEW_DISTANCE];
}

function directionTo(texel: readonly [number, number]): string {
  const target = texelCenterWorld(texel);
  const direction = target.map((value, axis) => value - (ORIGIN[axis] ?? 0));
  const length = Math.hypot(...direction);
  return `vec3<f32>(${direction.map((value) => (value / length).toFixed(8)).join(', ')})`;
}

it('descends a real depth-pyramid seed to each non-center source texel and rejects its empty footprint neighbors', async () => {
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
  const rays = [...SOURCES, ...EMPTY]
    .map(
      (texel, index) => `
  {
    let hit = traceScreenRay(origin, ${directionTo(texel)}, 6.0, 0.2, fullSize,
      coarsestDepth, maxTraceLevel);
    traceProbe[${index}] = vec4<f32>(hit.hit, hit.uv, hit.thickness);
  }`,
    )
    .join('');
  const trace = await compiler.compileShader(
    `${shader('ssr-trace')}
@group(1) @binding(0) var<storage, read_write> traceProbe: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_trace() {
  let fullSize = vec2<u32>(4u, 4u);
  // Same level bound and coarsest-depth gate as evaluateSsrTrace.
  let coarsestLevel = ssrDepthPyramidLevelCount() - 1u;
  let maxTraceLevel = min(maxSsrTraceLevel(fullSize), coarsestLevel + 1u);
  let coarsestDepth = textureLoad(depthPyramid, vec2<i32>(0), i32(coarsestLevel)).r;
  let origin = vec3<f32>(${ORIGIN.join(', ')});
  traceProbe[${SOURCES.length + EMPTY.length}] = vec4<f32>(f32(maxTraceLevel), coarsestDepth, 0.0, 0.0);${rays}
}`,
    { id: 'forgeax_ssr::pyramid-descent-trace', imports: common },
  );
  if (!trace.ok || !trace.value) throw new Error(JSON.stringify(trace.error));
  const pyramid = await compiler.compileShader(shader('depth-pyramid-seed'), {
    id: 'forgeax_depth_pyramid::descent-seed',
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
  const normal = device
    .createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      format: 'r32uint',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  // Reflection fallback (coverage in alpha) and the temporal source share one
  // fully covered, static texture.
  const data = device
    .createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
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

    // Camera-facing, fully covered surfaces everywhere; only depth decides.
    const surface = new Float32Array(Array.from({ length: 16 }, () => [0.5, 0.5, 1, 1]).flat());
    writePackedNormals(device, normal, 4, 4, surface);
    device.queue
      .writeTexture(
        { texture: data },
        surface,
        { bytesPerRow: 4 * 16, rowsPerImage: 4 },
        { width: 4, height: 4, depthOrArrayLayers: 1 },
      )
      .unwrap();

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
  let source = ${SOURCES.map(([x, y]) => `(x == ${x}u && y == ${y}u)`).join(' || ')};
  return select(0.0, ${SOURCE_DEPTH}, source);
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
            binding: 1,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'uint', viewDimension: '2d' },
          },
          ...[3, 6, 7].map((binding) => ({
            binding,
            visibility: GPU_SHADER_STAGE_COMPUTE,
            texture: { sampleType: 'unfilterable-float' as const, viewDimension: '2d' as const },
          })),
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
        compute: { module: traceModule, entryPoint: 'probe_trace' },
      })
      .unwrap();

    const depthView = device.createTextureView(depth, {}).unwrap();
    const normalView = device.createTextureView(normal, {}).unwrap();
    const dataView = device.createTextureView(data, {}).unwrap();
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
          { binding: 1, resource: { kind: 'textureView', value: normalView } },
          { binding: 3, resource: { kind: 'textureView', value: pyramidView } },
          { binding: 5, resource: { kind: 'buffer', value: { buffer: view } } },
          { binding: 6, resource: { kind: 'textureView', value: dataView } },
          { binding: 7, resource: { kind: 'textureView', value: dataView } },
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

    // The trace walks the pyramid: one level above full resolution, and every
    // pyramid cell holds its footprint's source.
    const levels = (SOURCES.length + EMPTY.length) * 4;
    expect(values[levels]).toBe(1);
    expect(values[levels + 1]).toBeCloseTo(SOURCE_VIEW_DISTANCE, 4);
    // Each result is [hit, u, v, thickness]. A source hit lands on its own
    // texel center, never on the footprint center or a neighbor.
    SOURCES.forEach(([x, y], index) => {
      const [hit, u = NaN, v = NaN, thickness] = Array.from(values.slice(index * 4, index * 4 + 4));
      expect(hit, `source (${x},${y}) is hit`).toBe(1);
      expect(u * 4, `source (${x},${y}) u`).toBeCloseTo(x + 0.5, 3);
      expect(v * 4, `source (${x},${y}) v`).toBeCloseTo(y + 0.5, 3);
      expect(thickness).toBe(1);
    });
    EMPTY.forEach(([x, y], offset) => {
      const index = SOURCES.length + offset;
      expect(values[index * 4], `empty (${x},${y}) shares a source footprint but is sky`).toBe(0);
    });
  } finally {
    device.destroyTexture(depth).unwrap();
    device.destroyTexture(normal).unwrap();
    device.destroyTexture(data).unwrap();
    device.destroyTexture(pyramidTexture).unwrap();
    for (const buffer of [view, output, readback]) device.destroyBuffer(buffer).unwrap();
  }
});
