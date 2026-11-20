import { readFileSync } from 'node:fs';
import { projectMaterialParameterSchema } from '@forgeax/engine-types';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WATER_SURFACE_PARAMETERS } from '../../../water/src/material-family';

let device: GPUDevice;
const pipelines = new Map<
  string,
  { pipeline: GPURenderPipeline; reads: readonly { group: number; binding: number }[] }
>();
const errors: string[] = [];
beforeAll(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Shallow foam response requires a real GPU adapter');
  device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
});
afterAll(() => {
  device?.destroy();
  expect(errors).toEqual([]);
});

it.each([
  { additive: true, enabled: true, source: 0.5, shared: null, expected: [0, 1] },
  { additive: true, enabled: true, source: 0, shared: null, expected: [0, 0] },
  { additive: true, enabled: false, source: 0.5, shared: null, expected: [0, 0] },
  { additive: false, enabled: true, source: 0.5, shared: null, expected: [0.5, 0.5] },
  { additive: true, enabled: true, source: 0.5, shared: 0, expected: [0, 1] },
  { additive: true, enabled: true, source: 0.5, shared: 0.125, expected: [0, 1] },
  { additive: true, enabled: true, source: 0.5, shared: 0.75, expected: [0, 1] },
  { additive: true, enabled: true, source: 0, shared: 0, expected: [0, 0] },
  {
    additive: true,
    enabled: true,
    source: 0.1,
    shared: null,
    residual: true,
    expected: [0, 0.1],
  },
  { additive: true, enabled: true, source: 0.1, shared: 0, residual: true, expected: [0, 0.1] },
  {
    additive: true,
    enabled: true,
    source: 0.5,
    shared: 0.125,
    residual: true,
    expected: [0, 0.5],
  },
  {
    additive: true,
    enabled: true,
    source: 0,
    shared: 0.125,
    residual: true,
    expected: [0, 32 / 255],
  },
  {
    additive: true,
    enabled: true,
    source: 0,
    shared: 0.75,
    residual: true,
    expected: [0, 191 / 255],
  },
  { additive: true, enabled: true, source: 0, shared: 1, residual: true, expected: [0, 1] },
  {
    additive: true,
    enabled: true,
    source: 0,
    shared: 1,
    residual: true,
    localFluid: true,
    expected: [0, 0.046875],
  },
  { additive: true, enabled: false, source: 0.1, shared: 0, residual: true, expected: [0, 0] },
])('composes source-qualified shallow and contact foam ($additive/$enabled/$source/$shared)', async (test) => {
  const textures: GPUTexture[] = [];
  const buffers: GPUBuffer[] = [];
  try {
    const key = `${test.additive}/${test.enabled}/${test.shared !== null}`;
    let cached = pipelines.get(key);
    if (cached === undefined) {
      const started = performance.now();
      const compiler = await import(
        /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
      );
      const imports = Object.fromEntries(
        [
          'water-waves',
          'water-fluid',
          'water-advanced-sampling',
          'water-transition-continuity',
          'tbn',
        ].map((name) => {
          const source = readFileSync(new URL(`../${name}.wgsl`, import.meta.url), 'utf8');
          const path = /^#define_import_path\s+(\S+)/m.exec(source)?.[1];
          if (path === undefined) throw new Error(`Missing production module identity: ${name}`);
          return [path, source];
        }),
      );
      imports['forgeax_material::water_deformation_v1'] = compiler.waterDeformationAbiSource();
      const parameters = projectMaterialParameterSchema(
        WATER_SURFACE_PARAMETERS,
        'shallow-foam',
        'cook',
      ).unwrap();
      imports['forgeax_material::parameters'] =
        compiler.generateParameterModule(
          parameters.filter((field) => !field.type.startsWith('texture')),
          { sceneMaterialPrivate: true },
        ) +
        `
@group(0) @binding(0) var waterFoamTexture_sampler:sampler;
@group(0) @binding(1) var waterFoamTexture:texture_2d<f32>;
@group(0) @binding(2) var waterFoamNormalTexture_sampler:sampler;
@group(0) @binding(3) var waterFoamNormalTexture:texture_2d<f32>;
@group(0) @binding(4) var waterVolumeNoiseTexture_sampler:sampler;
@group(0) @binding(5) var waterVolumeNoiseTexture:texture_3d<f32>;
@group(0) @binding(6) var surfaceFoamSimulationSampler:sampler;
@group(0) @binding(7) var surfaceFoamHeightSampler:sampler;
@group(0) @binding(8) var surfaceFoamSimulationTexture:texture_2d<f32>;
@group(0) @binding(9) var waterShallowGridTexture:texture_2d<f32>;
@group(0) @binding(10) var waterShallowNormalTexture:texture_2d<f32>;
@group(0) @binding(11) var waterShallowFoamTexture:texture_2d<f32>;
@group(0) @binding(12) var waterShallowMappingTexture:texture_2d<f32>;`;
      imports['forgeax_view::common'] = `
#define_import_path forgeax_view::common
struct View { temporalProjection:vec4<f32> }
var<private> view:View;`;
      imports['forgeax_view::atmosphere'] = `
#define_import_path forgeax_view::atmosphere
#import forgeax_view::common::{View}
fn view_distant_sky_light(view:View)->f32{return 1.0;}`;
      const surfaceInterface = readFileSync(
        new URL('../single-layer-water-surface_v1.wgsl', import.meta.url),
        'utf8',
      ).replace(/^#define_import_path[^\n]*\n/m, '');
      const surface = readFileSync(new URL('../water-surface.wgsl', import.meta.url), 'utf8')
        .replace(/^#define_import_path[^\n]*\n/m, '')
        .replace(/^#import forgeax_material::single_layer_water_surface_v1[^\n]*\n/m, '');
      const compiled = (
        await compiler.compileShader(
          `
#import forgeax_material::parameters::{material,waterFoamTexture_sampler,waterFoamTexture,waterFoamNormalTexture_sampler,waterFoamNormalTexture,waterVolumeNoiseTexture_sampler,waterVolumeNoiseTexture,surfaceFoamSimulationSampler,surfaceFoamHeightSampler,surfaceFoamSimulationTexture}
#import forgeax_view::common::{view}
${surfaceInterface}
${surface}
@vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4<f32>{
  let points=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
  return vec4<f32>(points[index],0.5,1.0);
}
@fragment fn fs(@builtin(position) pixel:vec4<f32>)->@location(0) vec4<f32>{
  material.roughness=0.2;material.fresnelRoughness=0.2;
  material.criticalAngleWidth=1.0;material.criticalAngleBendWidth=1.0;
  material.refractionDistanceM=100.0;material.coefficientMask=1.0;material.simulationWaterDepthM=1.0;
  material.foamTilingM=2.0;material.foamDepthMinimumM=1.0;
  material.foamTextureBlendMinimum=2.0;material.foamTextureBlendWidth=1.0;
  material.foamPower=1.0;material.foamBoost=1.0;material.foamAmount=1.0;
  material.contactFoamAmount=1.0;
  material.foamNormalZ=1.0;material.foamNormalUvOffset=0.1;material.foamRoughness=0.5;
  material.foamFrontScaleM=1.0;material.waveCaptureSizeM=64.0;
  material.fluidSimulationSizeM=64.0;material.foamFluidEraseScale=1.0;material.foamEraseNearFluidSize=0.5;
  material.foamMaskNearFluid=1.0;
  material.foamScatteringPerM=vec3<f32>(1.0);material.causticsMaxIntensity=1.0;
  view.temporalProjection=vec4<f32>(0.1,1000.0,0.0,0.0);
  var input:SingleLayerWaterSurfaceInput;
  input.positionWS=vec3<f32>(pixel.x,0.0,0.0);input.originalPositionWS=input.positionWS;
  input.geometricNormalWS=vec3<f32>(0.0,1.0,0.0);input.originalNormalWS=input.geometricNormalWS;
  input.tangentWS=vec4<f32>(1.0,0.0,0.0,1.0);input.viewDirectionWS=input.originalNormalWS;
  input.frontFacing=true;input.pixelDepthM=10.0;input.sceneDepthWithoutWaterM=100.0;
  let result=evaluate_surface(input);
  return vec4<f32>(result.foam,result.scattering.x,result.roughness,1.0);
}`,
          {
            imports,
            defines: {
              WATER_SHALLOW_SIMULATION: true,
              WATER_SHALLOW_ADDITIVE: test.additive,
              WATER_OCEAN_FOAM: true,
              WATER_USE_FOAM: test.enabled,
              WATER_SHADOW_PASS: false,
              WATER_DEFAULT_DEFORMATION_AVAILABLE: false,
              WATER_ENABLE_WAVES: false,
              WATER_TRANSITION_AVAILABLE: false,
              WATER_OCEAN_PATCH: false,
              WATER_FLUID_SIMULATION: test.shared !== null,
              WATER_USE_NORMAL_TEXTURE: false,
              WATER_RIVER: false,
              WATER_USE_FIXED_HEIGHT: true,
              WATER_USE_FIXED_DEPTH: true,
              WATER_USE_INFO: false,
              WATER_USE_BAKED_SIMULATION: false,
            },
          },
        )
      ).unwrap();
      const composed = performance.now();
      process.stdout.write(
        `${JSON.stringify({ test: 'water-shallow-foam', key, phase: 'composition', milliseconds: composed - started })}\n`,
      );
      const module = device.createShaderModule({ code: compiled.wgsl });
      expect(
        (await module.getCompilationInfo()).messages.filter((row) => row.type === 'error'),
      ).toEqual([]);
      const validated = performance.now();
      process.stdout.write(
        `${JSON.stringify({ test: 'water-shallow-foam', key, phase: 'module', milliseconds: validated - composed })}\n`,
      );
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
      });
      process.stdout.write(
        `${JSON.stringify({ test: 'water-shallow-foam', key, phase: 'native-pipeline', milliseconds: performance.now() - validated })}\n`,
      );
      cached = {
        pipeline,
        reads: compiled.reflection.entryPoints?.flatMap((point) => point.bindings) ?? [],
      };
      pipelines.set(key, cached);
    }
    const { pipeline, reads } = cached;
    const texture = (
      width: number,
      height: number,
      values: Float32Array | Uint8Array,
      volume = false,
    ) => {
      const floating = values instanceof Float32Array;
      const result = device.createTexture({
        size: [width, height, 1],
        dimension: volume ? '3d' : '2d',
        format: floating ? 'rgba32float' : 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      textures.push(result);
      device.queue.writeTexture(
        { texture: result },
        values,
        { bytesPerRow: width * (floating ? 16 : 4), rowsPerImage: height },
        [width, height, 1],
      );
      return result.createView();
    };
    const staticFoam = texture(2, 1, new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]));
    const normal = texture(1, 1, new Uint8Array([128, 128, 255, 255]));
    const volume = texture(1, 1, new Uint8Array([0, 0, 0, 255]), true);
    const zero = texture(1, 1, new Uint8Array([Math.round((test.shared ?? 0) * 255), 0, 0, 0]));
    const gridValues = new Float32Array(16 * 32 * 4);
    const normalValues = new Float32Array(gridValues.length);
    for (let index = 0; index < 16 * 32; index++) {
      gridValues[index * 4 + 1] = 88;
      normalValues[index * 4 + 2] = 1;
    }
    const grid = texture(16, 32, gridValues);
    const shallowNormal = texture(16, 32, normalValues);
    const foamValues = new Float32Array(16 * 16 * 4);
    for (let index = 0; index < 16 * 16; index++) foamValues[index * 4] = test.source;
    const foam = texture(16, 16, foamValues);
    const mapping = texture(
      2,
      2,
      new Float32Array([
        0,
        0,
        64,
        64,
        0,
        1,
        Number('residual' in test && test.residual),
        0,
        0,
        0,
        64,
        64,
        0,
        1,
        Number('residual' in test && test.residual),
        0,
      ]),
    );
    const sampler = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat' });
    const resources = new Map<number, GPUBindingResource>([
      [0, sampler],
      [1, staticFoam],
      [2, sampler],
      [3, normal],
      [4, sampler],
      [5, volume],
      [6, sampler],
      [7, sampler],
      [8, zero],
      [9, grid],
      [10, shallowNormal],
      [11, foam],
      [12, mapping],
    ]);
    const buffer = (data: Uint8Array, uniform = false) => {
      const result = device.createBuffer({
        size: data.byteLength,
        usage:
          (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) | GPUBufferUsage.COPY_DST,
      });
      buffers.push(result);
      device.queue.writeBuffer(result, 0, data);
      return result;
    };
    const body = new Uint8Array(128);
    new Float32Array(body.buffer, 80, 4).set([0, 88, 0, 0]);
    const bodyBuffer = buffer(body);
    const draw = buffer(new Uint8Array(16), true);
    if (test.shared !== null) {
      const descriptor = new Float32Array(36);
      // Publish shared contact coverage for both local solver states.
      descriptor[11] = 1;
      if ('localFluid' in test && test.localFluid) {
        descriptor.set([0, 0, 64, 64], 0);
        descriptor[5] = 1;
        descriptor[10] = 1;
        descriptor.set([1, 1], 12);
        descriptor.set([0, 0, 64, 64], 20);
        descriptor.set([1, 1], 28);
      }
      const descriptors = buffer(new Uint8Array(descriptor.buffer));
      const fields = device.createTexture({
        size: [1, 1, 4],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
      textures.push(fields);
      resources.set(20, fields.createView({ dimension: '2d-array' }));
      resources.set(21, { buffer: descriptors });
    }
    const target = device.createTexture({
      size: [2, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    textures.push(target);
    const readback = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    buffers.push(readback);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          ...new Set(reads.filter((read) => read.group === 0).map((read) => read.binding)),
        ].map((binding) => {
          const resource = resources.get(binding);
          if (resource === undefined) throw new Error(`Missing production foam binding ${binding}`);
          return { binding, resource };
        }),
      }),
    );
    pass.setBindGroup(
      2,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [
          { binding: 16, resource: { buffer: bodyBuffer } },
          { binding: 21, resource: { buffer: draw } },
        ],
      }),
    );
    if (test.shared !== null) {
      pass.setBindGroup(
        1,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(1),
          entries: [
            ...new Set(reads.filter((read) => read.group === 1).map((read) => read.binding)),
          ].map((binding) => {
            const resource = resources.get(binding);
            if (resource === undefined)
              throw new Error(`Missing production fluid binding ${binding}`);
            return { binding, resource };
          }),
        }),
      );
    }
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      [2, 1],
    );
    device.queue.submit([encoder.finish()]);
    const submitted = performance.now();
    await readback.mapAsync(GPUMapMode.READ);
    process.stdout.write(
      `${JSON.stringify({ test: 'water-shallow-foam', key, source: test.source, phase: 'readback', milliseconds: performance.now() - submitted })}\n`,
    );
    const values = new Float32Array(readback.getMappedRange());
    for (const [index, expected] of test.expected.entries()) {
      expect(values[index * 4]).toBeCloseTo(expected, 5);
      if (test.additive) expect(values[index * 4 + 1]).toBeCloseTo(expected, 5);
    }
    readback.unmap();
    expect(errors).toEqual([]);
  } finally {
    for (const texture of textures) texture.destroy();
    for (const buffer of buffers) buffer.destroy();
  }
}, 120_000);
