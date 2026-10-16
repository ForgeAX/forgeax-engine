import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { type DepthPyramidExtent, nextDepthPyramidMipExtent } from '../depth-pyramid/plan';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
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

const EMPTY_DEPTH = 1e30;

function readShader(name: string): string {
  return readFileSync(resolve(process.cwd(), `packages/shader/src/${name}.wgsl`), 'utf8');
}

async function createDevice() {
  return (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
}

async function createReducerPipeline(device: Awaited<ReturnType<typeof createDevice>>) {
  const module = createShaderModuleImmediate(device, {
    code: await compileShader('depth-pyramid-reduce', 'forgeax_depth_pyramid::odd-reduce'),
  }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
        },
      ],
    })
    .unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module, entryPoint: 'depth_pyramid_reduce' },
    })
    .unwrap();
  return { layout, pipeline };
}

it('retains an odd normalized boundary source texel in both reducer cells', async () => {
  const device = await createDevice();
  const pyramid = device
    .createTexture({
      // The physical mip is 2x1. With the normalized overlap contract, source
      // x=2 belongs to destination x=0 and x=1 (5 -> 2).
      size: { width: 5, height: 2, depthOrArrayLayers: 1 },
      mipLevelCount: 2,
      format: 'r32float',
      textureBindingViewDimension: '2d',
      usage:
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_STORAGE_BINDING |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const readback = device
    .createBuffer({
      size: 256,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    })
    .unwrap();
  try {
    const source = new Float32Array(5 * 2).fill(EMPTY_DEPTH);
    source[2] = 7;
    device.queue
      .writeTexture(
        { texture: pyramid, mipLevel: 0 },
        source,
        { bytesPerRow: 5 * 4, rowsPerImage: 2 },
        { width: 5, height: 2, depthOrArrayLayers: 1 },
      )
      .unwrap();

    const { layout, pipeline } = await createReducerPipeline(device);
    const sourceView = device
      .createTextureView(pyramid, { baseMipLevel: 0, mipLevelCount: 1 })
      .unwrap();
    const outputView = device
      .createTextureView(pyramid, { baseMipLevel: 1, mipLevelCount: 1 })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: sourceView } },
          { binding: 1, resource: { kind: 'textureView', value: outputView } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: pyramid, mipLevel: 1 },
      { buffer: readback, offset: 0, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 2, height: 1, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const values = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();

    expect(values[0]).toBeCloseTo(7, 5);
    expect(values[1]).toBeCloseTo(7, 5);
  } finally {
    device.destroyTexture(pyramid).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});

type Probe = {
  readonly uv: readonly [number, number];
  readonly start: readonly [number, number];
  readonly delta: readonly [number, number];
  readonly coarseMip: number;
};

type SeedReduceProbeResult = {
  readonly levels: readonly Float32Array[];
  readonly rescue: readonly Float32Array[];
};

type Device = Awaited<ReturnType<typeof createDevice>>;

async function compileShader(name: string, id: string): Promise<string> {
  const compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as {
    compileShader(
      source: string,
      options: { id: string; imports: Record<string, string> },
    ): Promise<{ ok: boolean; value?: { wgsl: string }; error?: unknown }>;
  };
  const result = await compiler.compileShader(readShader(name), {
    id,
    imports: {
      'forgeax_view::common': readShader('common'),
      'forgeax_pbr::gbuffer': readShader('standard-gbuffer'),
      'forgeax_depth_pyramid::sample': readShader('depth-pyramid-sample'),
    },
  });
  if (!result.ok || !result.value) throw new Error(JSON.stringify(result.error));
  return result.value.wgsl;
}

function createDepthSeedPipeline(device: Device, validPixel: readonly [number, number]) {
  const depthSeed = createShaderModuleImmediate(device, {
    code: `
@vertex fn seed_vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn seed_depth(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
  let valid = u32(p.x) == ${validPixel[0]}u && u32(p.y) == ${validPixel[1]}u;
  return select(0.0, 0.75, valid);
}`,
  }).unwrap();
  return device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module: depthSeed, entryPoint: 'seed_vertex', buffers: [] },
      fragment: { module: depthSeed, entryPoint: 'seed_depth', targets: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    })
    .unwrap();
}

function createSeedPipeline(device: Device, code: string) {
  const module = createShaderModuleImmediate(device, { code }).unwrap();
  const layout = device
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
  const pipeline = device
    .createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module, entryPoint: 'depth_pyramid_seed' },
    })
    .unwrap();
  return { layout, pipeline };
}

function createTraceProbeCode(fullSize: DepthPyramidExtent, probes: readonly Probe[]): string {
  const calls = probes
    .map(
      (probe, index) => `
  let candidate${index} = locateSsrPyramidCandidate(
    vec2<f32>(${probe.uv[0]}, ${probe.uv[1]}), ${probe.coarseMip}u, fullSize,
    vec2<f32>(${probe.start[0]}, ${probe.start[1]}),
    vec2<f32>(${probe.delta[0]}, ${probe.delta[1]}), 0.0, 1.0);
  rescueProbe[${index}] = vec4<f32>(select(0.0, 1.0, candidate${index}.valid),
    vec2<f32>(candidate${index}.pixel), candidate${index}.fraction);`,
    )
    .join('');
  return `
@group(1) @binding(0) var<storage, read_write> rescueProbe: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_rescue() {
  let fullSize = vec2<u32>(${fullSize.width}u, ${fullSize.height}u);${calls}
}`;
}

function createTracePipeline(device: Device, code: string) {
  const module = createShaderModuleImmediate(device, { code }).unwrap();
  const inputLayout = device
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
  const outputLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'storage' } }],
    })
    .unwrap();
  const pipeline = device
    .createComputePipeline({
      layout: device
        .createPipelineLayout({ bindGroupLayouts: [inputLayout, outputLayout] })
        .unwrap(),
      compute: { module, entryPoint: 'probe_rescue' },
    })
    .unwrap();
  return { inputLayout, outputLayout, pipeline };
}

function seedExtents(fullSize: DepthPyramidExtent): DepthPyramidExtent[] {
  const extents: DepthPyramidExtent[] = [];
  let current = nextDepthPyramidMipExtent(fullSize);
  while (true) {
    extents.push(current);
    if (current.width === 1 && current.height === 1) return extents;
    current = nextDepthPyramidMipExtent(current);
  }
}

async function runSeedReduceProbe(input: {
  readonly fullSize: DepthPyramidExtent;
  readonly validPixel: readonly [number, number];
  readonly probes: readonly Probe[];
}): Promise<SeedReduceProbeResult> {
  const seedCode = await compileShader('depth-pyramid-seed', 'forgeax_depth_pyramid::odd-seed');
  const traceCode = await compileShader(
    'ssr-trace',
    `forgeax_ssr::pyramid-odd-trace-${input.fullSize.width}x${input.fullSize.height}`,
  );
  const device = await createDevice();
  const extents = seedExtents(input.fullSize);
  const pyramid = device
    .createTexture({
      size: {
        width: extents[0]?.width ?? 1,
        height: extents[0]?.height ?? 1,
        depthOrArrayLayers: 1,
      },
      mipLevelCount: extents.length,
      format: 'r32float',
      textureBindingViewDimension: '2d',
      usage:
        GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_STORAGE_BINDING |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const depth = device
    .createTexture({
      size: { ...input.fullSize, depthOrArrayLayers: 1 },
      format: 'depth32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const view = device
    .createBuffer({
      size: VIEW_UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const traceOutput = device
    .createBuffer({
      size: Math.max(16, input.probes.length * 16),
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    })
    .unwrap();
  const levelOffsets: number[] = [];
  let readbackSize = 0;
  for (const extent of extents) {
    levelOffsets.push(readbackSize);
    readbackSize += 256 * extent.height;
  }
  const traceOffset = readbackSize;
  readbackSize += Math.max(256, input.probes.length * 16);
  const readback = device
    .createBuffer({
      size: readbackSize,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    })
    .unwrap();
  try {
    const payload = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    payload.set([1, 10, 0, 0], 228);
    device.queue.writeBuffer(view, 0, payload).unwrap();

    const depthPipeline = createDepthSeedPipeline(device, input.validPixel);
    const { layout: seedLayout, pipeline: seedPipeline } = createSeedPipeline(device, seedCode);
    const { layout: reduceLayout, pipeline: reducePipeline } = await createReducerPipeline(device);
    const {
      inputLayout,
      outputLayout,
      pipeline: tracePipeline,
    } = createTracePipeline(
      device,
      `${traceCode}${createTraceProbeCode(input.fullSize, input.probes)}`,
    );

    const depthView = device.createTextureView(depth, {}).unwrap();
    const seedView = device
      .createTextureView(pyramid, { baseMipLevel: 0, mipLevelCount: 1 })
      .unwrap();
    const fullPyramidView = device.createTextureView(pyramid, {}).unwrap();
    const seedGroup = device
      .createBindGroup({
        layout: seedLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: depthView } },
          { binding: 1, resource: { kind: 'textureView', value: seedView } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: view } } },
        ],
      })
      .unwrap();
    const reduceGroups = extents.slice(0, -1).map((_, level) => {
      const sourceView = device
        .createTextureView(pyramid, { baseMipLevel: level, mipLevelCount: 1 })
        .unwrap();
      const outputView = device
        .createTextureView(pyramid, { baseMipLevel: level + 1, mipLevelCount: 1 })
        .unwrap();
      return device
        .createBindGroup({
          layout: reduceLayout,
          entries: [
            { binding: 0, resource: { kind: 'textureView', value: sourceView } },
            { binding: 1, resource: { kind: 'textureView', value: outputView } },
          ],
        })
        .unwrap();
    });
    const traceInputGroup = device
      .createBindGroup({
        layout: inputLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: depthView } },
          { binding: 3, resource: { kind: 'textureView', value: fullPyramidView } },
          { binding: 5, resource: { kind: 'buffer', value: { buffer: view } } },
        ],
      })
      .unwrap();
    const traceOutputGroup = device
      .createBindGroup({
        layout: outputLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: traceOutput } } }],
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
    raster.setPipeline(depthPipeline);
    raster.draw(3);
    raster.end();
    const seedPass = encoder.beginComputePass();
    seedPass.setPipeline(seedPipeline);
    seedPass.setBindGroup(0, seedGroup);
    seedPass.dispatchWorkgroups(
      Math.ceil((extents[0]?.width ?? 1) / 8),
      Math.ceil((extents[0]?.height ?? 1) / 8),
    );
    seedPass.end();
    for (const [level, group] of reduceGroups.entries()) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(reducePipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(
        Math.ceil((extents[level + 1]?.width ?? 1) / 8),
        Math.ceil((extents[level + 1]?.height ?? 1) / 8),
      );
      pass.end();
    }
    const tracePass = encoder.beginComputePass();
    tracePass.setPipeline(tracePipeline);
    tracePass.setBindGroup(0, traceInputGroup);
    tracePass.setBindGroup(1, traceOutputGroup);
    tracePass.dispatchWorkgroups(1);
    tracePass.end();
    for (const [level, extent] of extents.entries()) {
      encoder.copyTextureToBuffer(
        { texture: pyramid, mipLevel: level },
        {
          buffer: readback,
          offset: levelOffsets[level] ?? 0,
          bytesPerRow: 256,
          rowsPerImage: extent.height,
        },
        { width: extent.width, height: extent.height, depthOrArrayLayers: 1 },
      );
    }
    encoder.copyBufferToBuffer(traceOutput, 0, readback, traceOffset, input.probes.length * 16);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
    const values = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const levels = extents.map((extent, level) => {
      const result = new Float32Array(extent.width * extent.height);
      const base = (levelOffsets[level] ?? 0) / 4;
      for (let y = 0; y < extent.height; y += 1) {
        for (let x = 0; x < extent.width; x += 1) {
          result[y * extent.width + x] = values[base + y * 64 + x] ?? Number.NaN;
        }
      }
      return result;
    });
    const rescueBase = traceOffset / 4;
    const rescue = input.probes.map((_, index) =>
      values.slice(rescueBase + index * 4, rescueBase + index * 4 + 4),
    );
    return { levels, rescue };
  } finally {
    device.destroyTexture(depth).unwrap();
    device.destroyTexture(pyramid).unwrap();
    for (const buffer of [view, traceOutput, readback]) device.destroyBuffer(buffer).unwrap();
  }
}

it('keeps the trailing 6x2 source texel through the real seed-to-reduce-rescue chain', async () => {
  const result = await runSeedReduceProbe({
    fullSize: { width: 6, height: 2 },
    validPixel: [5, 0],
    probes: [
      {
        uv: [5.5 / 6, 0.25],
        start: [0, 0],
        delta: [1, 0],
        coarseMip: 2,
      },
    ],
  });
  const expected = (1 * 10) / (10 - 0.25 * (10 - 1));
  expect(result.levels[0]?.[2]).toBeCloseTo(expected, 5);
  expect(result.levels[1]?.[0]).toBeCloseTo(expected, 5);
  expect(result.rescue[0]?.[0]).toBe(1);
  expect(result.rescue[0]?.[1]).toBe(5);
  expect(result.rescue[0]?.[2]).toBe(0);
  expect(result.rescue[0]?.[3]).toBeCloseTo(5.5 / 6, 5);
});

it('keeps real seed overlap and rejects the neighboring empty cell', async () => {
  const valid = await runSeedReduceProbe({
    fullSize: { width: 5, height: 2 },
    validPixel: [2, 0],
    probes: [
      { uv: [0.49, 0.25], start: [0, 0], delta: [1, 0], coarseMip: 1 },
      { uv: [0.51, 0.25], start: [0, 0], delta: [1, 0], coarseMip: 1 },
    ],
  });
  const expected = (1 * 10) / (10 - 0.25 * 9);
  expect(valid.levels[0]?.[0]).toBeCloseTo(expected, 5);
  expect(valid.levels[0]?.[1]).toBeCloseTo(expected, 5);
  expect(valid.rescue[0]?.slice(0, 3)).toEqual(new Float32Array([1, 2, 0]));
  expect(valid.rescue[1]?.slice(0, 3)).toEqual(new Float32Array([1, 2, 0]));

  const trailing = await runSeedReduceProbe({
    fullSize: { width: 5, height: 2 },
    validPixel: [4, 0],
    probes: [{ uv: [0.49, 0.25], start: [0, 0], delta: [1, 0], coarseMip: 1 }],
  });
  expect(trailing.levels[0]?.[0]).toBeGreaterThan(1e30);
  expect(trailing.rescue[0]?.[0]).toBe(0);
});

it('preserves the trailing Y row and two odd descent levels', async () => {
  const transposed = await runSeedReduceProbe({
    fullSize: { width: 2, height: 6 },
    validPixel: [0, 5],
    probes: [
      {
        uv: [0.25, 5.5 / 6],
        start: [0, 0],
        delta: [0, 1],
        coarseMip: 2,
      },
    ],
  });
  const expected = (1 * 10) / (10 - 0.25 * 9);
  expect(transposed.levels[0]?.[2]).toBeCloseTo(expected, 5);
  expect(transposed.levels[1]?.[0]).toBeCloseTo(expected, 5);
  expect(transposed.rescue[0]?.slice(0, 3)).toEqual(new Float32Array([1, 0, 5]));

  const multiLevel = await runSeedReduceProbe({
    fullSize: { width: 14, height: 6 },
    validPixel: [13, 5],
    probes: [
      {
        uv: [13.5 / 14, 5.5 / 6],
        start: [0, 0],
        delta: [1, 0],
        coarseMip: 3,
      },
    ],
  });
  expect(multiLevel.levels[0]?.[20]).toBeCloseTo(expected, 5);
  expect(multiLevel.levels[1]?.[2]).toBeCloseTo(expected, 5);
  expect(multiLevel.levels[2]?.[0]).toBeCloseTo(expected, 5);
  expect(multiLevel.rescue[0]?.slice(0, 3)).toEqual(new Float32Array([1, 13, 5]));
});
