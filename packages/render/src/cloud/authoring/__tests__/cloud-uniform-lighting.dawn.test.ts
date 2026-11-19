/// <reference types="@webgpu/types" />
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { VIEW_UNIFORM_BYTES } from '../../../record/view-ubo';
import type { CloudMaterialAsset } from '../../contracts';
import { createCloudCookers } from '../assets';

const half = (bits: number): number => {
  const exponent = (bits >>> 10) & 31;
  const mantissa = bits & 1023;
  if (exponent === 31) return mantissa === 0 ? Number.POSITIVE_INFINITY : Number.NaN;
  return exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15);
};

interface LightingFixtureOptions {
  readonly albedo?: number;
  readonly emission?: number;
  readonly materialAO?: number;
  readonly sky?: number;
  readonly enableSky?: boolean;
  readonly ordinaryCasesOnly?: boolean;
  readonly mode0Fp32?: boolean;
  readonly fogOracle?: 'air' | 'height';
  readonly lowOpticalDepth?: boolean;
}

type LightingCase = readonly [
  cosine: number,
  octaves: number,
  selfShadow: number,
  override: number,
  intensity: number,
  phaseG: number,
];

async function cookUniformLighting(options: LightingFixtureOptions) {
  const engine = await loadEngineShaderEntries();
  const registry = new NativeCookerRegistry();
  const oracleFog = `#define_import_path forgeax_view::fog
#import forgeax_view::common::View
struct KnownFog { transmittance: vec3f, inscatter: vec3f }
struct KnownHeightFog { transmittance: f32, inscatter: vec3f }
fn view_fog(v:View,p:vec3f)->KnownFog {
  return KnownFog(vec3f(0.2,0.4,0.8),vec3f(1.0,2.0,3.0)*p.y*0.001);
}
fn height_fog_with_source(v:View,p:vec3f,source:vec3f)->KnownHeightFog {
  return KnownHeightFog(0.5,source*p.y*0.001);
}`;
  const imports =
    options.fogOracle === undefined
      ? engine.imports
      : { ...engine.imports, 'forgeax_view::fog': oracleFog };
  for (const cooker of createCloudCookers({
    loadSource: async () => {
      throw new Error('Uniform material must not load author WGSL');
    },
    loadRendererModules: async () => ({ imports, sourcePaths: [] }),
    compilerIdentity: async () => 'uniform-real-compiler',
    compile: (code, id, imports) =>
      compileShader(code, { id, ...(imports === undefined ? {} : { imports }) }),
  }))
    registry.register(cooker);
  const sample = {
    extinctionPerMeter: 0.00012,
    albedo: Array(3).fill(options.albedo ?? 0.8),
    emissivePerMeter: Array(3).fill(options.emission ?? 0),
    materialAO: options.materialAO ?? 1,
  };
  const draft = (
    await registry.runDraft<CloudMaterialAsset>('cloud-material', {
      guid: '019a50a5-0000-7000-8000-000000000004',
      sourcePath: 'clouds.pack.ts',
      source: { version: 1, model: { kind: 'uniform', sample }, parameters: {} },
    })
  ).unwrap();
  const renderer = draft.payload.variants[0]?.renderer;
  if (!renderer) throw new Error('Uniform renderer artifact missing');
  const artifact = draft.artifacts[renderer.artifact];
  if (!artifact) throw new Error('Missing actual cooked bytes');
  return { renderer, artifact };
}

function makeDepthWriter(device: GPUDevice, fogOracle: LightingFixtureOptions['fogOracle']) {
  const depthWriterModule = device.createShaderModule({
    code: `
@vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4f {
let uv=vec2f(f32((index<<1u)&2u),f32(index&2u));
return vec4f(uv*2.0-1.0,0.0,1.0);
}
@fragment fn fs()->@builtin(frag_depth) f32 {return 0.0001;}`,
  });
  return fogOracle === undefined
    ? undefined
    : device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: depthWriterModule, entryPoint: 'vs' },
        fragment: { module: depthWriterModule, entryPoint: 'fs', targets: [] },
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'always',
        },
      });
}

function createUniformLightingPipeline(
  device: GPUDevice,
  module: GPUShaderModule,
  options: LightingFixtureOptions,
  format: GPUTextureFormat,
) {
  return device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: {
      module,
      entryPoint:
        options.fogOracle === 'air'
          ? 'fs_trace_mode_zero_air'
          : options.mode0Fp32
            ? 'fs_trace_mode_zero'
            : 'fs_main',
      targets: [{ format }, { format }, { format: 'rgba32float' }],
    },
  });
}

interface LightingTargets {
  scene: GPUTexture;
  map: GPUTexture;
  depth: GPUTexture;
  depthWriter: GPURenderPipeline | undefined;
  pipeline: GPURenderPipeline;
  outputs: readonly GPUTexture[];
  viewBinding: GPUBindGroup;
  inputs: GPUBindGroup;
  readback: GPUBuffer;
}

async function renderUniformLightingCase(
  device: GPUDevice,
  targets: LightingTargets,
  options: LightingFixtureOptions,
) {
  const { scene, map, depth, depthWriter, pipeline, outputs, viewBinding, inputs, readback } =
    targets;
  const encoder = device.createCommandEncoder();
  encoder
    .beginRenderPass({
      colorAttachments: [scene, map].map((target) => ({
        view: target.createView(),
        loadOp: 'clear',
        storeOp: 'store',
      })),
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
    })
    .end();
  if (depthWriter !== undefined) {
    const depthPass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    depthPass.setPipeline(depthWriter);
    depthPass.setScissorRect(0, 0, 2, 4);
    depthPass.draw(3);
    depthPass.end();
  }
  const pass = encoder.beginRenderPass({
    colorAttachments: outputs.map((target) => ({
      view: target.createView(),
      loadOp: 'clear',
      storeOp: 'store',
    })),
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, viewBinding);
  pass.setBindGroup(1, inputs);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: outputs[options.mode0Fp32 ? 0 : 1] as GPUTexture },
    { buffer: readback, bytesPerRow: 256 },
    [4, 4],
  );
  if (options.fogOracle !== undefined)
    encoder.copyTextureToBuffer(
      { texture: outputs[1] as GPUTexture },
      { buffer: readback, offset: 1024, bytesPerRow: 256 },
      [4, 4],
    );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const range = readback.getMappedRange();
  const actual = options.mode0Fp32
    ? Array.from(new Float32Array(range, 0, 4))
    : Array.from(new Uint16Array(range, 0, 4), half);
  const nearActual =
    options.fogOracle === undefined ? undefined : Array.from(new Float32Array(range, 1024, 4));
  readback.unmap();
  return { actual, nearActual };
}

function uniformLightingInputs(options: LightingFixtureOptions) {
  const params = new Float32Array(64);
  params.set([5000, 10000, 350000, 200000], 0);
  params.set([192, 0, 0, -1], 8);
  params.set([0.15, -0.2, 0, 0], 12);
  params.set([0.5, 0.5, 0.5, 0], 16);
  params.set([0, 10, 15000, 0], 20);
  params.set([0, -1, 0, 200000], 36);
  params.set([64, 1, 0, 0], 40);
  params.set([options.sky ?? 0, options.sky ?? 0, options.sky ?? 0, 0], 48);
  params.set([0, Number(options.enableSky ?? false), 0, 0], 52);
  const view = new Float32Array(VIEW_UNIFORM_BYTES / 4);
  view.set([10, 10, 10], 20);
  view.set([1, 0, 0, 0, 0, 0, 1, 0, 0, -10000, 0, 0, 0, 10001, 0, 1], 44);
  if (options.fogOracle !== undefined) view.set([1, 2, 3, 0], 284);
  return { params, view };
}

function usesLightingCase(options: LightingFixtureOptions, sample: LightingCase): boolean {
  const [cosine, octaves, selfShadow, override, intensity, phaseG] = sample;
  if (options.ordinaryCasesOnly && intensity > 10) return false;
  if (options.fogOracle === undefined) return true;
  return (
    cosine === 1 &&
    octaves === 0 &&
    selfShadow === 0 &&
    override === -1 &&
    intensity === 10 &&
    phaseG === 0.15
  );
}

function lowOpticalDepthRadiance(
  options: LightingFixtureOptions,
  phase: number,
  intensity: number,
  octaves: number,
  extinction: number,
  ds: number,
): number {
  // Closed-form uniform slab oracle, independent of the step accumulation above.
  const length = 10000;
  const slabIntegral = extinction === 0 ? length : -Math.expm1(-extinction * length) / extinction;
  let expectedL = (options.emission ?? 0) * slabIntegral;
  if (options.enableSky)
    expectedL +=
      extinction *
      (options.albedo ?? 0.8) *
      (options.sky ?? 0) *
      (options.materialAO ?? 1) *
      slabIntegral;
  for (let octave = 0; octave <= octaves; octave++) {
    const scale = 0.5 ** (2 ** octave - 1);
    const octavePhase =
      octave === 0
        ? phase
        : 1 / (4 * Math.PI) + (phase - 1 / (4 * Math.PI)) * 0.5 ** (2 ** Math.max(0, octave - 1));
    const segmentRatio =
      extinction === 0 || extinction * scale === 0
        ? 1
        : -Math.expm1(-extinction * scale * ds) / (-Math.expm1(-extinction * ds) * scale);
    expectedL +=
      extinction *
      (options.albedo ?? 0.8) *
      scale *
      intensity *
      octavePhase *
      slabIntegral *
      segmentRatio;
  }
  return expectedL;
}

function uniformLightingOracle(options: LightingFixtureOptions, sample: LightingCase) {
  const [cosine, octaves, selfShadow, override, intensity, phaseG] = sample;
  const phase = (1 - phaseG ** 2) / (4 * Math.PI * (1 + phaseG ** 2 - 2 * phaseG * cosine) ** 1.5);
  const ds = 10000 / 192;
  const extinction = override < 0 ? 0.00012 : override;
  let expectedL = 0;
  let expectedNearL = 0;
  for (let index = 0; index < 192; index++) {
    let source = 0;
    for (let octave = 0; octave <= octaves; octave++) {
      const exponent = 2 ** octave - 1;
      const sigma = extinction * 0.5 ** exponent;
      const scattering = extinction * (options.albedo ?? 0.8) * 0.5 ** exponent;
      const octavePhase =
        1 / (4 * Math.PI) + (phase - 1 / (4 * Math.PI)) * 0.5 ** (2 ** Math.max(0, octave - 1));
      const radial = 6360000 + 5000 + (index + 0.5) * ds;
      const exit =
        -radial * cosine + Math.sqrt((6360000 + 15000) ** 2 - radial ** 2 * (1 - cosine ** 2));
      const sunT = Math.exp(-extinction * Math.min(15000, exit) * 0.5 ** exponent * selfShadow);
      source +=
        scattering *
        intensity *
        sunT *
        (octave === 0 ? phase : octavePhase) *
        (sigma === 0 ? ds : -Math.expm1(-sigma * ds) / sigma);
      if (octave === 0 && options.enableSky)
        source +=
          extinction *
          (options.albedo ?? 0.8) *
          (options.sky ?? 0) *
          (options.materialAO ?? 1) *
          (extinction === 0 ? ds : -Math.expm1(-extinction * ds) / extinction);
      if (octave === 0)
        source +=
          (options.emission ?? 0) *
          (extinction === 0 ? ds : -Math.expm1(-extinction * ds) / extinction);
    }
    expectedL += Math.exp(-extinction * ds * index) * source;
    if (index < 96) expectedNearL += Math.exp(-extinction * ds * index) * source;
  }
  if (options.lowOpticalDepth) {
    expectedL = lowOpticalDepthRadiance(options, phase, intensity, octaves, extinction, ds);
  }
  return { expectedL, expectedNearL, extinction, ds };
}

function assertFogReadback(
  fogOracle: NonNullable<LightingFixtureOptions['fogOracle']>,
  actual: number[],
  nearActual: number[] | undefined,
  expectedL: number,
  expectedNearL: number,
  extinction: number,
  ds: number,
) {
  const meanDepth = (count: number) => {
    let sum = 0,
      weight = 0;
    for (let i = 0; i < count; i++) {
      const w = Math.exp(-extinction * ds * i);
      sum += (5000 + (i + 0.5) * ds) * w;
      weight += w;
    }
    return sum / weight;
  };
  const nearMean = meanDepth(96),
    farMean = meanDepth(192);
  const nearT = Math.exp(-extinction * 5000),
    farT = Math.exp(-extinction * 10000);
  if (nearActual === undefined) throw new Error('Missing near production readback');
  for (let channel = 0; channel < 3; channel++) {
    const attenuation = fogOracle === 'air' ? ([0.2, 0.4, 0.8][channel] ?? 0) : 0.5;
    expect(actual[channel]).toBeCloseTo(
      attenuation * expectedL + (1 - farT) * (channel + 1) * farMean * 0.001,
      2,
    );
    expect(nearActual[channel]).toBeCloseTo(
      attenuation * expectedNearL + (1 - nearT) * (channel + 1) * nearMean * 0.001,
      2,
    );
  }
  expect(nearActual[3]).toBeCloseTo(nearT, 4);
  expect(actual[3]).toBeCloseTo(farT, 4);
  return {
    fogOracle,
    nearActual,
    actual,
    nearMean,
    farMean,
    expectedNearL,
    expectedL,
  };
}

function assertLightingReadback(
  actual: number[],
  expectedL: number,
  extinction: number,
  intensity: number,
  options: LightingFixtureOptions,
): void {
  expect(actual.every(Number.isFinite)).toBe(true);
  for (const channel of actual.slice(0, 3))
    expect(Math.abs(channel - expectedL)).toBeLessThan(
      options.lowOpticalDepth
        ? Math.max(1e-6, expectedL * 0.001)
        : intensity > 10
          ? Math.max(0.002, expectedL * 0.001)
          : 0.002,
    );
  expect(Math.abs((actual[3] ?? Number.NaN) - Math.exp(-extinction * 10000))).toBeLessThan(
    options.mode0Fp32 ? 1e-4 : 0.002,
  );
}

async function readUniformLighting(options: LightingFixtureOptions = {}) {
  const { renderer, artifact } = await cookUniformLighting(options);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No Dawn GPU adapter');
  if (process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE === '1') {
    expect(adapter.info.isFallbackAdapter).toBe(false);
    expect(adapter.info.vendor).not.toBe('');
    process.stdout.write(
      `uniform-lighting-device ${JSON.stringify({ vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, isFallbackAdapter: adapter.info.isFallbackAdapter, sourceDigest: renderer.programDigest })}\n`,
    );
  }
  const format = options.mode0Fp32 ? 'rgba32float' : 'rgba16float';
  const device = await adapter.requestDevice(
    options.mode0Fp32 ? { requiredLimits: { maxColorAttachmentBytesPerSample: 48 } } : {},
  );
  const resources: { destroy(): void }[] = [];
  try {
    const module = device.createShaderModule({ code: new TextDecoder().decode(artifact.bytes) });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await createUniformLightingPipeline(device, module, options, format);
    const texture = (format: GPUTextureFormat) => {
      const value = device.createTexture({
        size: [4, 4],
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
      resources.push(value);
      return value;
    };
    const scene = texture('rgba16float');
    const depth = texture('depth32float');
    const map = texture('rgba32float');
    const outputs = [texture(format), texture(format), texture('rgba32float')];
    const buffer = (size: number, usage: GPUBufferUsageFlags) => {
      const value = device.createBuffer({ size, usage });
      resources.push(value);
      return value;
    };
    const viewBuffer = buffer(VIEW_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const paramsBuffer = buffer(256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const readback = buffer(2048, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const depthWriter = await makeDepthWriter(device, options.fogOracle);
    const inputs = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: scene.createView() },
        {
          binding: 1,
          resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
        },
        { binding: 2, resource: { buffer: paramsBuffer } },
        { binding: 3, resource: depth.createView() },
        { binding: 5, resource: map.createView() },
        { binding: 6, resource: scene.createView() },
        { binding: 7, resource: scene.createView() },
      ],
    });
    const viewBinding = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: viewBuffer } }],
    });
    const { params, view } = uniformLightingInputs(options);
    const records: unknown[] = [];
    const cases = options.lowOpticalDepth
      ? ([
          [1, 0, 0, 1e-10, 120000, 0.15],
          [0.2, 2, 0, 1e-7, 120000, 0.15],
          [0.2, 2, 0, 1e-10, 120000, 0.15],
          [1, 0, 0, 0, 120000, 0.15],
        ] as const)
      : ([
          [1, 0, 0, -1, 10, 0.15],
          [0.2, 0, 0, -1, 10, 0.15],
          [0.2, 2, 0, -1, 10, 0.15],
          [0.2, 2, 1, -1, 10, 0.15],
          [0.2, 0, 0, 0.00024, 10, 0.15],
          [0.2, 0, 0, 0, 10, 0.15],
          [1, 0, 0, -1, 120000, 0.15],
          [1, 0, 0, -1, 120000, 0.99],
        ] as const);
    for (const sample of cases) {
      const [cosine, octaves, selfShadow, override, intensity, phaseG] = sample;
      if (!usesLightingCase(options, sample)) continue;
      view.set([-Math.sqrt(1 - cosine * cosine), -cosine, 0], 16);
      params[19] = octaves;
      params[20] = selfShadow;
      params[11] = override;
      params[12] = phaseG;
      view.set([intensity, intensity, intensity], 20);
      device.queue.writeBuffer(viewBuffer, 0, view);
      device.queue.writeBuffer(paramsBuffer, 0, params);
      const { actual, nearActual } = await renderUniformLightingCase(
        device,
        { scene, map, depth, depthWriter, pipeline, outputs, viewBinding, inputs, readback },
        options,
      );
      const { expectedL, expectedNearL, extinction, ds } = uniformLightingOracle(options, sample);
      process.stdout.write(
        `uniform-lighting-case ${JSON.stringify({ cosine, octaves, selfShadow, override, intensity, phaseG, format, actual: actual.map((value) => (Number.isFinite(value) ? value : String(value))), expectedL })}\n`,
      );
      if (options.fogOracle !== undefined) {
        records.push(
          assertFogReadback(
            options.fogOracle,
            actual,
            nearActual,
            expectedL,
            expectedNearL,
            extinction,
            ds,
          ),
        );
        continue;
      }
      assertLightingReadback(actual, expectedL, extinction, intensity, options);
      records.push({
        cosine,
        octaves,
        selfShadow,
        override,
        actual,
        expectedL,
        expectedT: Math.exp(-extinction * 10000),
      });
    }
    process.stdout.write(`uniform-lighting-readbacks ${JSON.stringify(records)}\n`);
  } finally {
    for (const resource of resources) resource.destroy();
    device.destroy();
  }
}

it(
  'reads FP32 Mode 0 cooked lighting against independent Beer/HG and multiple-scattering references',
  () => readUniformLighting({ mode0Fp32: true }),
  30000,
);

it('retains low-tau scattering, sky and emission against a closed-form FP64 slab oracle', async () => {
  await readUniformLighting({ mode0Fp32: true, lowOpticalDepth: true });
  await readUniformLighting({ mode0Fp32: true, lowOpticalDepth: true, albedo: 0 });
  await readUniformLighting({
    mode0Fp32: true,
    lowOpticalDepth: true,
    albedo: 0,
    emission: 0.0002,
  });
  await readUniformLighting({
    mode0Fp32: true,
    lowOpticalDepth: true,
    emission: 0.0002,
    sky: 4,
    enableSky: true,
  });
}, 30000);

it('applies actual material AO only to the sky fill and preserves direct solar transport', async () => {
  for (const materialAO of [0, 1])
    await readUniformLighting({ materialAO, sky: 4, enableSky: true, ordinaryCasesOnly: true });
  await readUniformLighting({ materialAO: 1, sky: 0, enableSky: true, ordinaryCasesOnly: true });
  await readUniformLighting({ materialAO: 1, sky: 4, enableSky: false, ordinaryCasesOnly: true });
}, 30000);

it('preserves absorption and emissive-only media when incident lighting is skipped', async () => {
  await readUniformLighting({ albedo: 0, emission: 0, ordinaryCasesOnly: true, mode0Fp32: true });
  await readUniformLighting({
    albedo: 0,
    emission: 0.0002,
    ordinaryCasesOnly: true,
    mode0Fp32: true,
  });
}, 30000);

it('uses distinct production near and far mean positions for air and for no-atmosphere height fog', async () => {
  await readUniformLighting({ mode0Fp32: true, fogOracle: 'air' });
  await readUniformLighting({ mode0Fp32: true, fogOracle: 'height' });
}, 30000);
