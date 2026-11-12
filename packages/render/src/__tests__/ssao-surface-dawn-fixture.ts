import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mat4 } from '@forgeax/engine-math';
import { expect } from 'vitest';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { generateSsaoKernel, generateSsaoNoise } from '../ssao-buffers';

export type SsaoSurfaceAlgorithm = 'ssao' | 'gtao';
export type SsaoSurfaceScene =
  | 'plane'
  | 'orthographic'
  | 'contact'
  | 'distant-edge'
  | 'background'
  | 'plane-odd'
  | 'plane-jitter';

interface CompiledSsaoPrograms {
  readonly gbufferSource: string;
  readonly fragmentWgsl: string;
  readonly computeWgsl: string | undefined;
}

interface SsaoSurfaceResources {
  readonly size: number;
  readonly aoSize: number;
  readonly depth: GPUTexture;
  readonly normal: GPUTexture;
  readonly raw: GPUTexture;
  readonly computeRaw: GPUTexture | undefined;
  readonly blurred: GPUTexture;
  readonly noise: GPUTexture;
  readonly uniform: GPUBuffer;
  readonly kernel: GPUBuffer;
  readonly readback: GPUBuffer;
  readonly computeReadback: GPUBuffer | undefined;
}

interface GtaoComputePass {
  readonly pipeline: GPUComputePipeline;
  readonly group: GPUBindGroup;
}

interface SsaoSurfacePipelines {
  readonly seed: GPURenderPipeline;
  readonly module: GPUShaderModule;
  readonly calc: GPURenderPipeline;
  readonly calcBindings: GPUBindGroup;
  readonly compute: GtaoComputePass | undefined;
}

interface RawReadback {
  readonly fragment: Uint8Array;
  readonly compute: Uint8Array | undefined;
}

function readShader(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

async function compilePrograms(algorithm: SsaoSurfaceAlgorithm): Promise<CompiledSsaoPrograms> {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const gbufferSource = readShader('packages/shader/src/standard-gbuffer.wgsl');
  const ssaoSource = readShader('packages/shader/src/hdrp-ssao.wgsl');
  const commonSource = readShader('packages/shader/src/common.wgsl');
  const compiled = await compiler.compileShader(ssaoSource, {
    id: 'forgeax_hdrp::ssao',
    imports: {
      'forgeax_pbr::gbuffer': gbufferSource,
      'forgeax_view::common': commonSource,
    },
  });
  if (!compiled.ok) throw compiled.error;
  if (algorithm !== 'gtao')
    return { gbufferSource, fragmentWgsl: compiled.value.wgsl, computeWgsl: undefined };
  const computeCompiled = await compiler.compileShader(
    readShader('packages/shader/src/hdrp-gtao-compute.wgsl'),
    {
      id: 'forgeax_hdrp::gtao_compute',
      computeEntry: 'cs_gtao_calc',
      imports: {
        'forgeax_hdrp::ssao': ssaoSource,
        'forgeax_pbr::gbuffer': gbufferSource,
        'forgeax_view::common': commonSource,
      },
    },
  );
  if (!computeCompiled.ok) throw computeCompiled.error;
  return {
    gbufferSource,
    fragmentWgsl: compiled.value.wgsl,
    computeWgsl: computeCompiled.value.wgsl,
  };
}

function createSurfaceResources(
  device: GPUDevice,
  algorithm: SsaoSurfaceAlgorithm,
  scene: SsaoSurfaceScene,
): SsaoSurfaceResources {
  const size = scene === 'plane-odd' ? 127 : 128;
  const aoSize = Math.ceil(size / 2);
  const texture = (format: GPUTextureFormat, width = size, height = size, additionalUsage = 0) =>
    device.createTexture({
      size: [width, height],
      format,
      usage:
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_COPY_SRC |
        GPU_TEXTURE_USAGE_COPY_DST |
        additionalUsage,
    });
  const computeRaw =
    algorithm === 'gtao'
      ? texture('rgba8unorm', aoSize, aoSize, GPU_TEXTURE_USAGE_STORAGE_BINDING)
      : undefined;
  return {
    size,
    aoSize,
    depth: texture('depth32float'),
    normal: texture('r32uint'),
    raw: texture('rgba8unorm', aoSize, aoSize),
    computeRaw,
    blurred: texture('r8unorm', aoSize, aoSize),
    noise: texture('rgba32float', 4, 4),
    uniform: device.createBuffer({
      size: 256,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    }),
    kernel: device.createBuffer({
      size: 1024,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    }),
    readback: device.createBuffer({
      size: 256 * aoSize,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    }),
    computeReadback:
      computeRaw === undefined
        ? undefined
        : device.createBuffer({
            size: 256 * aoSize,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
          }),
  };
}

function tiltedScene(scene: SsaoSurfaceScene): boolean {
  return (
    scene === 'plane' ||
    scene === 'plane-odd' ||
    scene === 'plane-jitter' ||
    scene === 'orthographic'
  );
}

function rayYExpression(scene: SsaoSurfaceScene): string {
  return `(1.0-2.0*in.uv.y + ${scene === 'plane-jitter' ? '0.013' : '0.0'})*0.577350269`;
}

function distanceExpression(scene: SsaoSurfaceScene): string {
  if (scene === 'orthographic') return '4.0+(1.0-2.0*in.uv.y)*3.0';
  if (scene === 'contact') return 'select(4.0,3.75,in.uv.x>0.5)';
  if (scene === 'distant-edge') return 'select(4.0,1.0,in.uv.x>0.5)';
  if (scene === 'background') return '100.0';
  return '4.0/(1.0-rayY)';
}

function depthExpression(scene: SsaoSurfaceScene): string {
  if (scene === 'orthographic') return '(100.0-distance)/99.9';
  if (scene === 'background') return '0.0';
  return '(10.0/distance-0.1)/99.9';
}

function normalExpression(scene: SsaoSurfaceScene): string {
  return tiltedScene(scene)
    ? 'encodeStandardNormalRoughness(vec3f(0,1,1), 1)'
    : 'encodeStandardNormalRoughness(vec3f(0,0,1), 1)';
}

function createSeedPipeline(
  device: GPUDevice,
  gbufferSource: string,
  scene: SsaoSurfaceScene,
): GPURenderPipeline {
  const source = `
    ${gbufferSource.replace(/^#define_import_path[^\n]*\n/m, '')}
    struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
    @vertex fn vs(@builtin(vertex_index) i:u32)->Out {
      let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
      return Out(vec4f(p[i],0,1),p[i]*vec2f(0.5,-0.5)+0.5);
    }
    struct Fragment { @builtin(frag_depth) depth:f32, @location(0) normal:u32 };
    @fragment fn fs(in:Out)->Fragment {
      let rayY = ${rayYExpression(scene)};
      let distance = ${distanceExpression(scene)};
      return Fragment(${depthExpression(scene)},${normalExpression(scene)});
    }`;
  const module = device.createShaderModule({ code: source });
  return device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32uint' }] },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
  });
}

function createCalcPipeline(
  device: GPUDevice,
  resources: SsaoSurfaceResources,
  module: GPUShaderModule,
): { readonly pipeline: GPURenderPipeline; readonly bindings: GPUBindGroup } {
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
      { binding: 1, visibility: 2, buffer: { type: 'uniform' } },
      { binding: 2, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: 2, sampler: { type: 'non-filtering' } },
      { binding: 4, visibility: 2, texture: { sampleType: 'uint' } },
      { binding: 5, visibility: 2, texture: { sampleType: 'depth' } },
      { binding: 6, visibility: 2, sampler: { type: 'non-filtering' } },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs_ssao' },
    fragment: { module, entryPoint: 'fs_ssao_calc', targets: [{ format: 'rgba8unorm' }] },
  });
  const bindings = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: resources.uniform } },
      { binding: 1, resource: { buffer: resources.kernel } },
      { binding: 2, resource: resources.noise.createView() },
      {
        binding: 3,
        resource: device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat' }),
      },
      { binding: 4, resource: resources.normal.createView() },
      { binding: 5, resource: resources.depth.createView() },
      { binding: 6, resource: device.createSampler() },
    ],
  });
  return { pipeline, bindings };
}

function createComputePass(
  device: GPUDevice,
  resources: SsaoSurfaceResources,
  module: GPUShaderModule | undefined,
): GtaoComputePass | undefined {
  if (module === undefined || resources.computeRaw === undefined) return undefined;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 4, visibility: 4, texture: { sampleType: 'uint', viewDimension: '2d' } },
      { binding: 5, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d' } },
      {
        binding: 9,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
      },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: 'cs_gtao_calc' },
  });
  const group = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: resources.uniform },
      { binding: 4, resource: resources.normal.createView() },
      { binding: 5, resource: resources.depth.createView() },
      { binding: 9, resource: resources.computeRaw.createView() },
    ],
  });
  return { pipeline, group };
}

function createPipelines(
  device: GPUDevice,
  resources: SsaoSurfaceResources,
  scene: SsaoSurfaceScene,
  programs: CompiledSsaoPrograms,
): SsaoSurfacePipelines {
  const module = device.createShaderModule({ code: programs.fragmentWgsl });
  const computeModule =
    programs.computeWgsl === undefined
      ? undefined
      : device.createShaderModule({ code: programs.computeWgsl });
  const calc = createCalcPipeline(device, resources, module);
  return {
    seed: createSeedPipeline(device, programs.gbufferSource, scene),
    module,
    calc: calc.pipeline,
    calcBindings: calc.bindings,
    compute: createComputePass(device, resources, computeModule),
  };
}

function writeSurfaceInputs(
  device: GPUDevice,
  resources: SsaoSurfaceResources,
  algorithm: SsaoSurfaceAlgorithm,
  scene: SsaoSurfaceScene,
  sampleCount: number,
): void {
  const projection = mat4.create();
  if (scene === 'orthographic') mat4.orthographicReverseZ(projection, -3, 3, 3, -3, 0.1, 100);
  else mat4.perspectiveReverseZ(projection, Math.PI / 3, 1, 0.1, 100);
  if (scene === 'plane-jitter') {
    const jitter = mat4.identity(mat4.create());
    jitter[12] = 0.017;
    jitter[13] = -0.013;
    mat4.multiply(projection, jitter, projection);
  }
  const inverse = mat4.create();
  mat4.invert(inverse, projection);
  const payload = new Float32Array(64);
  payload.set(mat4.identity(mat4.create()));
  payload.set(projection, 16);
  payload.set(inverse, 32);
  payload.set([1, 0.5, algorithm === 'gtao' ? 0 : 0.025, sampleCount], 48);
  payload.set([algorithm === 'gtao' ? 1 : 0, 1, 1, 1], 52);
  device.queue.writeBuffer(resources.uniform, 0, payload);
  device.queue.writeBuffer(
    resources.kernel,
    0,
    new Float32Array(generateSsaoKernel().flatMap((value) => [...value, 0])),
  );
  const noiseRgb = generateSsaoNoise();
  const noiseRgba = new Float32Array(64);
  for (let index = 0; index < 16; index++)
    noiseRgba.set(noiseRgb.subarray(index * 3, index * 3 + 3), index * 4);
  device.queue.writeTexture({ texture: resources.noise }, noiseRgba, { bytesPerRow: 64 }, [4, 4]);
}

function encodeSeed(
  device: GPUDevice,
  resources: SsaoSurfaceResources,
  pipeline: GPURenderPipeline,
): void {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: resources.normal.createView(), loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: {
      view: resources.depth.createView(),
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      depthClearValue: 0,
    },
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

async function readRawSurface(
  device: GPUDevice,
  resources: SsaoSurfaceResources,
  pipelines: SsaoSurfacePipelines,
): Promise<RawReadback> {
  const encoder = device.createCommandEncoder();
  if (pipelines.compute !== undefined && resources.computeReadback !== undefined) {
    const compute = encoder.beginComputePass({ label: 'gtao-shared-raw-compute' });
    compute.setPipeline(pipelines.compute.pipeline);
    compute.setBindGroup(0, pipelines.compute.group);
    compute.dispatchWorkgroups(Math.ceil(resources.aoSize / 8), Math.ceil(resources.aoSize / 8), 1);
    compute.end();
    encoder.copyTextureToBuffer(
      { texture: resources.computeRaw as GPUTexture },
      { buffer: resources.computeReadback, bytesPerRow: 256 },
      [resources.aoSize, resources.aoSize],
    );
  }
  const fragment = encoder.beginRenderPass({
    colorAttachments: [{ view: resources.raw.createView(), loadOp: 'clear', storeOp: 'store' }],
  });
  fragment.setPipeline(pipelines.calc);
  fragment.setBindGroup(0, pipelines.calcBindings);
  fragment.draw(3);
  fragment.end();
  encoder.copyTextureToBuffer(
    { texture: resources.raw },
    { buffer: resources.readback, bytesPerRow: 256 },
    [resources.aoSize, resources.aoSize],
  );
  device.queue.submit([encoder.finish()]);
  await resources.readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
  if (resources.computeReadback !== undefined)
    await resources.computeReadback.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
  return {
    fragment: new Uint8Array(resources.readback.getMappedRange()),
    compute:
      resources.computeReadback === undefined
        ? undefined
        : new Uint8Array(resources.computeReadback.getMappedRange()),
  };
}

function meanAo(values: Uint8Array, aoSize: number, x0: number, x1: number): number {
  let sum = 0;
  for (let y = 8; y < aoSize - 8; y++)
    for (let x = x0; x < x1; x++) sum += 1 - (values[y * 256 + x * 4] ?? Number.NaN) / 255;
  return sum / ((aoSize - 16) * (x1 - x0));
}

function assertRawSurface(
  algorithm: SsaoSurfaceAlgorithm,
  scene: SsaoSurfaceScene,
  aoSize: number,
  values: RawReadback,
  errors: readonly string[],
): void {
  if (values.compute !== undefined) {
    let maximumDelta = 0;
    for (let y = 0; y < aoSize; y++)
      for (let x = 0; x < aoSize * 4; x++) {
        const offset = y * 256 + x;
        maximumDelta = Math.max(
          maximumDelta,
          Math.abs((values.fragment[offset] ?? 0) - (values.compute[offset] ?? 0)),
        );
      }
    expect(
      maximumDelta,
      'fragment and compute share raw GTAO values and normal encoding',
    ).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
  const center = (aoSize >> 1) * 256 + (aoSize >> 1) * 4;
  const ox = ((values.fragment[center + 1] ?? Number.NaN) / 255) * 2 - 1;
  const oy = ((values.fragment[center + 2] ?? Number.NaN) / 255) * 2 - 1;
  const oz = 1 - Math.abs(ox) - Math.abs(oy);
  const expected = tiltedScene(scene) ? [0, Math.SQRT1_2, Math.SQRT1_2] : [0, 0, 1];
  const length = Math.hypot(ox, oy, oz);
  expect(
    (ox * (expected[0] ?? 0) + oy * (expected[1] ?? 0) + oz * (expected[2] ?? 0)) / length,
    'raw carries the center world normal',
  ).toBeGreaterThan(0.999);
  if (scene === 'contact') {
    expect(
      meanAo(values.fragment, aoSize, aoSize / 2 - 4, aoSize / 2),
      'nearby foreground occludes the contact band',
    ).toBeGreaterThan(0.02);
    expect(
      meanAo(values.fragment, aoSize, 8, 16),
      'open surface away from contact stays clear',
    ).toBeLessThan(algorithm === 'gtao' ? 0.00001 : 0.01);
    return;
  }
  if (scene === 'distant-edge')
    expect(meanAo(values.fragment, aoSize, aoSize / 2 - 4, aoSize / 2)).toBeLessThan(0.005);
  expect(
    meanAo(values.fragment, aoSize, 8, aoSize - 8),
    'unoccluded surface and distant silhouettes stay clear',
  ).toBeLessThan(algorithm === 'gtao' ? 0.00001 : 0.01);
}

function createBlurPipeline(
  device: GPUDevice,
  module: GPUShaderModule,
): { readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout } {
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
      { binding: 4, visibility: 2, texture: { sampleType: 'uint' } },
      { binding: 5, visibility: 2, texture: { sampleType: 'depth' } },
      { binding: 6, visibility: 2, sampler: { type: 'non-filtering' } },
      { binding: 7, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs_ssao' },
    fragment: { module, entryPoint: 'fs_ssao_blur', targets: [{ format: 'r8unorm' }] },
  });
  return { pipeline, layout };
}

async function readBlurredSurface(
  device: GPUDevice,
  resources: SsaoSurfaceResources,
  owner: { readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout },
): Promise<Uint8Array> {
  const group = device.createBindGroup({
    layout: owner.layout,
    entries: [
      { binding: 0, resource: { buffer: resources.uniform } },
      { binding: 4, resource: resources.normal.createView() },
      { binding: 5, resource: resources.depth.createView() },
      { binding: 6, resource: device.createSampler() },
      { binding: 7, resource: resources.raw.createView() },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: resources.blurred.createView(), loadOp: 'clear', storeOp: 'store' }],
  });
  pass.setPipeline(owner.pipeline);
  pass.setBindGroup(0, group);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: resources.blurred },
    { buffer: resources.readback, bytesPerRow: 256 },
    [resources.aoSize, resources.aoSize],
  );
  device.queue.submit([encoder.finish()]);
  await resources.readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ);
  return new Uint8Array(resources.readback.getMappedRange());
}

function assertBlurredSurface(
  scene: SsaoSurfaceScene,
  aoSize: number,
  filtered: Uint8Array,
  errors: readonly string[],
): void {
  if (scene === 'contact') {
    let foreground = 0;
    for (let y = 8; y < aoSize - 8; y++)
      for (let x = aoSize / 2; x < aoSize / 2 + 3; x++)
        foreground += 1 - (filtered[y * 256 + x] ?? Number.NaN) / 255;
    expect(
      foreground / ((aoSize - 16) * 3),
      'bilateral blur must not bleed contact AO onto the foreground',
    ).toBeLessThan(0.005);
  }
  expect(errors).toEqual([]);
}

function disposeSurface(device: GPUDevice, resources: SsaoSurfaceResources): void {
  for (const resource of [
    resources.depth,
    resources.normal,
    resources.raw,
    resources.computeRaw,
    resources.blurred,
    resources.noise,
    resources.uniform,
    resources.kernel,
    resources.readback,
    resources.computeReadback,
  ])
    if (resource !== undefined) resource.destroy();
  device.destroy();
}

export async function runSsaoSurfaceCase(
  algorithm: SsaoSurfaceAlgorithm,
  scene: SsaoSurfaceScene,
  sampleCount: number,
): Promise<void> {
  const programs = await compilePrograms(algorithm);
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const resources = createSurfaceResources(device, algorithm, scene);
  try {
    const pipelines = createPipelines(device, resources, scene, programs);
    writeSurfaceInputs(device, resources, algorithm, scene, sampleCount);
    encodeSeed(device, resources, pipelines.seed);
    const raw = await readRawSurface(device, resources, pipelines);
    assertRawSurface(algorithm, scene, resources.aoSize, raw, errors);
    resources.readback.unmap();
    resources.computeReadback?.unmap();
    const blur = createBlurPipeline(device, pipelines.module);
    const filtered = await readBlurredSurface(device, resources, blur);
    assertBlurredSurface(scene, resources.aoSize, filtered, errors);
    resources.readback.unmap();
  } finally {
    disposeSurface(device, resources);
  }
}
