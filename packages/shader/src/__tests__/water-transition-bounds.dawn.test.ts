import { readFileSync } from 'node:fs';
import { projectMaterialParameterSchema, WATER_DEFORMATION_INPUTS } from '@forgeax/engine-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WATER_SURFACE_PARAMETERS } from '../../../water/src/material-family';
import { WATER_BODY_DATA_STRIDE_BYTES } from '../../../water/src/waves';

const shaderRoot = new URL('../', import.meta.url);
const imports = Object.fromEntries(
  ['water-waves', 'water-deformation-input', 'water-deformation-default', 'water-fluid'].map(
    (name) => {
      const source = readFileSync(new URL(`${name}.wgsl`, shaderRoot), 'utf8');
      const path = /^#define_import_path\s+(\S+)/m.exec(source)?.[1];
      if (path === undefined) throw new Error(`Missing production module identity: ${name}`);
      return [path, source];
    },
  ),
);
imports['forgeax_material::water_deformation_v1'] = `
#define_import_path forgeax_material::water_deformation_v1
struct WaterDeformationInput {
${WATER_DEFORMATION_INPUTS.map((field) => `${field.name}: ${field.type},`).join('\n')}
}
struct WaterDeformationOutput {
  currentPositionM: vec3<f32>, previousPositionM: vec3<f32>,
  currentNormalYUp: vec3<f32>, previousNormalYUp: vec3<f32>,
  waterMask: f32, bodyRenderIndex: u32,
}`;
imports['forgeax_material::parameters'] = `
#define_import_path forgeax_material::parameters
struct Parameters { maximumFlowVelocityMPerSec: f32, waveVelocityMaskThresholdMPerSec: f32, padding: vec2<f32> }
@group(1) @binding(0) var<uniform> material: Parameters;`;

let device: GPUDevice;
const errors: string[] = [];
beforeAll(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Water transition regression requires a Dawn adapter');
  device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
});
afterAll(() => {
  device?.destroy();
  expect(errors).toEqual([]);
});

async function compile(
  source: string,
  defines: Record<string, boolean>,
  extraImports: Record<string, string> = {},
): Promise<{
  module: GPUShaderModule;
  entryPoints: NonNullable<import('@forgeax/engine-types').ShaderReflection['entryPoints']>;
}> {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const compiled = await compiler.compileShader(source, {
    id: 'water-transition-bounds',
    imports: { ...imports, ...extraImports },
    defines: {
      WATER_ENABLE_WAVES: false,
      WATER_TRANSITION_AVAILABLE: true,
      WATER_TRANSITION_LAKE: true,
      WATER_TRANSITION_OCEAN: false,
      WATER_HEIGHT_MAPPING_AVAILABLE: true,
      WATER_VERTEX_FLOW_AVAILABLE: true,
      WATER_USE_FIXED_HEIGHT: true,
      WATER_USE_FIXED_DEPTH: true,
      WATER_USE_FIXED_VELOCITY: false,
      WATER_USE_INFO: false,
      WATER_USE_BAKED_SIMULATION: false,
      WATER_BAKED_HEIGHT_DEPTH_AVAILABLE: true,
      WATER_DYNAMIC_BOUNDS_CLIP: true,
      WATER_DEFAULT_DEFORMATION_AVAILABLE: true,
      ...defines,
    },
  });
  if (!compiled.ok) throw compiled.error;
  const module = device.createShaderModule({ code: compiled.value.wgsl });
  expect(
    (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
  ).toEqual([]);
  return { module, entryPoints: compiled.value.reflection.entryPoints ?? [] };
}

function buffer(data: ArrayBufferView, uniform = false) {
  const result = device.createBuffer({
    size: Math.max(data.byteLength, 16),
    usage: (uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(result, 0, data.buffer, data.byteOffset, data.byteLength);
  return result;
}

function bodyBytes() {
  expect(WATER_BODY_DATA_STRIDE_BYTES).toBe(128);
  const bytes = new Uint8Array(WATER_BODY_DATA_STRIDE_BYTES * 2);
  const data = new DataView(bytes.buffer);
  for (let index = 0; index < 2; index++) {
    const offset = index * WATER_BODY_DATA_STRIDE_BYTES;
    data.setUint32(offset, index, true);
    data.setUint32(offset + 4, 1, true);
    new Float32Array(bytes.buffer, offset + 16, 4).set([
      index === 0 ? 9 : 0.3,
      index === 0 ? 8 : 0.1,
      10,
      2,
    ]);
    new Float32Array(bytes.buffer, offset + 64, 4).set([1000, 4, index === 0 ? 4 : 80, 0]);
    new Float32Array(bytes.buffer, offset + 80, 4).set(
      index === 0 ? [4, 2, 0.25, 0] : [80, 40, 3, 4],
    );
    new Float32Array(bytes.buffer, offset + 112, 4).set(
      index === 0 ? [0, 0, 2, 2] : [100, 100, 20, 20],
    );
  }
  return bytes;
}

async function transition(
  source: 'vertex' | 'fixed' | 'baked' | 'water-info',
  threshold: number,
  defines: Record<string, boolean> = {},
  boundaryMask?: number,
  gpuHeader = false,
) {
  const compiled = await compile(
    `
#import forgeax_material::water_deformation_input::{waterDeformationInput, waterVertexFlowXZ, waterVertexFlowMPerSec, waterMeshFarContinuity}
#import forgeax_material::water_deformation_default::{deform_water_vertex}
#import forgeax_material::water_waves::{waterMeshFarBoundaryWeight, waterMeshTileWordOffset, waterMeshTileWords}
@group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let color = vec4<f32>(f32(id.x) * 0.0625, 0.25, 1.0, 1.0);
  let matrix = mat4x4<f32>(vec4<f32>(0.0, 0.0, 1.0, 0.0), vec4<f32>(0.0, 1.0, 0.0, 0.0),
    vec4<f32>(-1.0, 0.0, 0.0, 0.0), vec4<f32>(0.0, 0.0, 0.0, 1.0));
  let flow = waterVertexFlowMPerSec(waterVertexFlowXZ(color, matrix));
  let currentX = ${boundaryMask === undefined ? '1.0' : '128.0 - f32(id.x) * 2.0'};
  let previousX = currentX - 0.5;
  let input = waterDeformationInput(0u, 1u, vec3<f32>(currentX, 6.0, 0.0), vec3<f32>(previousX, 5.0, 0.0),
    vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0), vec2<f32>(currentX, 0.0), 0u, flow);
  let originalDeformation = deform_water_vertex(input);
  let deformation = waterMeshFarContinuity(input, originalDeformation, 0u);
  result[id.x * 5u] = vec4<f32>(deformation.currentPositionM, deformation.waterMask);
  result[id.x * 5u + 1u] = vec4<f32>(deformation.previousPositionM, input.timeSeconds);
  result[id.x * 5u + 2u] = vec4<f32>(deformation.currentNormalYUp, input.prevTimeSeconds);
  result[id.x * 5u + 3u] = vec4<f32>(deformation.previousNormalYUp, f32(deformation.bodyRenderIndex));
  result[id.x * 5u + 4u] = vec4<f32>(input.vertexFlowMPerSec, f32(input.bodyRenderIndex), f32(input.waveBodyRenderIndex));
  result[20u + id.x * 3u] = vec4<f32>(
    waterMeshFarBoundaryWeight(0u, input.bodyRenderIndex, input.waveBodyRenderIndex, input.positionM.xz),
    waterMeshFarBoundaryWeight(0u, input.bodyRenderIndex, input.waveBodyRenderIndex, input.previousPositionM.xz),
    f32(waterMeshTileWords[waterMeshTileWordOffset(0u) + 23u]), f32(waterMeshTileWords[15u]));
  result[21u + id.x * 3u] = vec4<f32>(originalDeformation.currentNormalYUp, 0.0);
  result[22u + id.x * 3u] = vec4<f32>(originalDeformation.previousNormalYUp, 0.0);
}`,
    {
      WATER_USE_FIXED_VELOCITY: source === 'fixed',
      WATER_USE_BAKED_SIMULATION: source === 'baked',
      WATER_USE_INFO: source === 'water-info',
      ...defines,
    },
  );
  const body = bodyBytes();
  if (boundaryMask !== undefined) new Float32Array(body.buffer, 112, 4).set([0, 0, 256, 256]);
  if (source === 'water-info') new DataView(body.buffer).setUint32(96, 2, true);
  const descriptors = new Uint8Array(96);
  new Float32Array(descriptors.buffer, 0, 4).set([-2, -2, 1, 1]);
  new Uint32Array(descriptors.buffer, 32, 4).set([5, 5, 0, 1]);
  const baked = new Float32Array(25 * 4);
  for (let index = 0; index < 25; index++) baked.set([4, 2, 0.6, 0], index * 4);
  const info = new Uint8Array(48);
  new Uint32Array(info.buffer, 0, 4).set([0, 1, 1, 0]);
  new Float32Array(info.buffer, 16, 4).set([0, 10, -10, 0]);
  new Float32Array(info.buffer, 32, 4).set([0, 0, 8, 8]);
  const texture = device.createTexture({
    size: [1, 1, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    new Float32Array([(0.4 + 10.24) / 20.48, 0.5, 0.4, 0]),
    {},
    [1, 1, 1],
  );
  const buffers = {
    material: buffer(new Float32Array([8, threshold, 0, 0]), true),
    body: buffer(body),
    waves: buffer(
      new Float32Array([
        1, 0, 20, 20, 0.25, 0.2, 1, 0.625, 0, 0, 0, 0, 1, 0, 2, 20, 0.25, 0.2, 1, 0.625, 0, 0, 0, 0,
      ]),
    ),
    info: buffer(info, true),
    draw: buffer(new Uint32Array([0, 0, 0, 0]), true),
    tiles: buffer(
      (() => {
        const words = new Uint32Array(gpuHeader ? 48 : 24);
        words[15] = boundaryMask === undefined ? 0 : 4;
        if (gpuHeader) {
          words[0] = 24;
          words[23] = 0x57474d31;
        }
        words[(gpuHeader ? 24 : 0) + 23] = boundaryMask ?? 0;
        return words;
      })(),
    ),
    bakedDescriptors: buffer(descriptors),
    baked: buffer(baked),
  };
  const output = device.createBuffer({
    size: (4 * 5 + 4 * 3) * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const resources = new Map<string, GPUBindingResource>([
    ['0:0', { buffer: output }],
    ['1:0', { buffer: buffers.material }],
    ['2:16', { buffer: buffers.body }],
    ['2:17', { buffer: buffers.waves }],
    ['2:18', texture.createView({ dimension: '2d-array' })],
    ['2:20', { buffer: buffers.info }],
    ['2:21', { buffer: buffers.draw }],
    ['2:22', { buffer: buffers.tiles }],
    ['2:23', { buffer: buffers.bakedDescriptors }],
    ['2:24', { buffer: buffers.baked }],
  ]);
  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: compiled.module, entryPoint: 'main' },
    });
    const reads = compiled.entryPoints.find((entry) => entry.name === 'main')?.bindings ?? [];
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    for (const group of new Set(reads.map((read) => read.group))) {
      const entries = reads
        .filter((read) => read.group === group)
        .map((read) => {
          const resource = resources.get(`${group}:${read.binding}`);
          if (resource === undefined)
            throw new Error(`Missing production binding ${group}:${read.binding}`);
          return { binding: read.binding, resource };
        });
      pass.setBindGroup(
        group,
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries }),
      );
    }
    pass.dispatchWorkgroups(4);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    return values;
  } finally {
    for (const resource of [...Object.values(buffers), output, readback, texture])
      resource.destroy();
  }
}

function wave(x: number, time: number) {
  const attenuation = 1 - Math.exp(-2 / 5);
  const phase = x * 0.2 - time;
  const normal = [Math.sin(phase) * 2 * attenuation * 0.2, 1 - Math.cos(phase) * 0.25, 0] as const;
  const length = Math.hypot(...normal);
  return {
    displacement: [
      -0.625 * 2 * attenuation * Math.sin(phase),
      2 * attenuation * Math.cos(phase),
      0,
    ] as const,
    normal: [normal[0] / length, normal[1] / length, normal[2] / length] as const,
  };
}

describe('source-owned Water transition deformation', () => {
  it.each([
    [0, false],
    [1, false],
    [2, false],
    [15, false],
    [0, true],
    [2, true],
  ] as const)('joins the flat far edge only for its selected side mask %s (GPU header=%s)', async (mask, gpuHeader) => {
    const values = await transition(
      'fixed',
      1,
      {
        WATER_ENABLE_WAVES: true,
        WATER_TRANSITION_AVAILABLE: false,
      },
      mask,
      gpuHeader,
    );
    for (let index = 0; index < 4; index++) {
      for (const [row, x, time] of [
        [0, 128 - index * 2, 0.3],
        [1, 127.5 - index * 2, 0.1],
      ] as const) {
        const distance = 128 - x;
        const blend = Math.max(0, Math.min(1, distance / 4));
        const weight = (mask & 2) === 0 ? 1 : blend * blend * (3 - 2 * blend);
        const expected = wave(x, time);
        const position = [x, 4, 0] as const;
        const normal = [
          expected.normal[0] * weight,
          1 - weight + expected.normal[1] * weight,
          expected.normal[2] * weight,
        ] as const;
        for (const axis of [0, 1, 2] as const) {
          expect(
            values[index * 20 + row * 4 + axis],
            `${index}/${row}/${axis} position`,
          ).toBeCloseTo(position[axis] + expected.displacement[axis] * weight, 5);
          expect(
            values[index * 20 + (row + 2) * 4 + axis],
            `${index}/${row}/${axis} normal`,
          ).toBeCloseTo(normal[axis] / Math.hypot(...normal), 5);
        }
      }
    }
  });
  it.each([
    'vertex',
    'fixed',
    'baked',
    'water-info',
  ] as const)('uses source %s velocity/height/depth and target waves/time', async (source) => {
    const values = await transition(source, 1);
    for (let index = 0; index < 4; index++) {
      expect(Array.from(values.slice(80 + index * 12, 84 + index * 12))).toEqual([1, 1, 0, 0]);
      expect(Array.from(values.slice(index * 20 + 8, index * 20 + 11))).toEqual(
        Array.from(values.slice(84 + index * 12, 87 + index * 12)),
      );
      expect(Array.from(values.slice(index * 20 + 12, index * 20 + 15))).toEqual(
        Array.from(values.slice(88 + index * 12, 91 + index * 12)),
      );
      const speed =
        source === 'vertex' ? index * 0.5 : { fixed: 0.25, baked: 0.6, 'water-info': 0.4 }[source];
      const weight = 1 - Math.min(speed, 1);
      for (const [row, position, time] of [
        [0, [1, 4, 0], 0.3],
        [1, [0.5, 4, 0], 0.1],
      ] as const) {
        const expected = wave(position[0], time);
        const normal = [
          expected.normal[0] * weight,
          1 - weight + expected.normal[1] * weight,
          expected.normal[2] * weight,
        ] as const;
        for (const axis of [0, 1, 2] as const) {
          expect(values[index * 20 + row * 4 + axis]).toBeCloseTo(
            position[axis] + expected.displacement[axis] * weight,
            5,
          );
          expect(values[index * 20 + (row + 2) * 4 + axis]).toBeCloseTo(
            normal[axis] / Math.hypot(...normal),
            5,
          );
        }
      }
      expect(values[index * 20 + 7]).toBeCloseTo(0.3, 6);
      expect(values[index * 20 + 11]).toBeCloseTo(0.1, 6);
      expect(values[index * 20 + 15]).toBe(0);
      expect(Array.from(values.slice(index * 20 + 18, index * 20 + 20))).toEqual([0, 1]);
      expect(values[index * 20 + 16]).toBeCloseTo(-index * 0.5, 6);
      expect(values[index * 20 + 17]).toBeCloseTo(0, 6);
    }
  });

  it('uses the authored velocity threshold and Ocean branch', async () => {
    const values = await transition('fixed', 0.5, {
      WATER_TRANSITION_LAKE: false,
      WATER_TRANSITION_OCEAN: true,
    });
    expect(values[1]).toBeCloseTo(4 + wave(1, 0.3).displacement[1] * 0.5, 5);
  });

  it('keeps ordinary waves independent of the transition mask', async () => {
    const values = await transition('fixed', 0.1, {
      WATER_ENABLE_WAVES: true,
      WATER_TRANSITION_AVAILABLE: false,
    });
    expect(values[1]).toBeCloseTo(4 + wave(1, 0.3).displacement[1], 5);
  });

  it('retains independent height mapping when waves and transitions are off', async () => {
    const values = await transition('fixed', 1, {
      WATER_TRANSITION_AVAILABLE: false,
      WATER_TRANSITION_LAKE: false,
    });
    expect(Array.from(values.slice(0, 3))).toEqual([1, 4, 0]);
    expect(Array.from(values.slice(4, 7))).toEqual([0.5, 4, 0]);
  });
});

it.each([
  'transition',
  'waves',
  'custom',
  'far',
  'inactive',
  'large-world',
  'boundary',
] as const)('evaluates stock pixel Normal with independent phase/depth and velocity coordinates (%s)', async (mode) => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const parameters = projectMaterialParameterSchema(
    WATER_SURFACE_PARAMETERS,
    'pixel-normal',
    'cook',
  );
  if (!parameters.ok) throw parameters.error;
  const extraImports = Object.fromEntries(
    [
      'tbn',
      'view-atmosphere',
      'common',
      'cloud',
      'cloud/geometry',
      'cloud/shadow',
      'atmosphere-optics',
      'atmosphere-visibility',
      'atmosphere-coordinates',
      'atmosphere-sampling',
      'atmosphere-table-access',
      'cluster-texture-data',
      'shadow-pcf',
    ].map((name) => {
      const source = readFileSync(new URL(`${name}.wgsl`, shaderRoot), 'utf8');
      const path = /^#define_import_path\s+(\S+)/m.exec(source)?.[1];
      if (path === undefined) throw new Error(`Missing production module identity: ${name}`);
      return [path, source];
    }),
  );
  extraImports['forgeax_material::parameters'] = compiler.generateParameterModule(
    parameters.value,
    {
      sceneMaterialPrivate: true,
    },
  );
  // Cook keeps the Surface ABI and implementation in the entry's lexical namespace.
  const surfaceInterface = readFileSync(
    new URL('single-layer-water-surface_v1.wgsl', shaderRoot),
    'utf8',
  ).replace(/^#define_import_path[^\n]*\n/m, '');
  const surfaceSource = readFileSync(new URL('water-surface.wgsl', shaderRoot), 'utf8')
    .replace(/^#define_import_path[^\n]*\n/m, '')
    .replace(/^#import forgeax_material::single_layer_water_surface_v1[^\n]*\n/m, '');
  const compiled = await compile(
    `
#import forgeax_material::parameters::{material}
${surfaceInterface}
${surfaceSource}
#import forgeax_material::water_deformation_input::{waterDeformationInput, waterMeshFarContinuity}
#import forgeax_material::water_deformation_default::{deform_water_vertex}
#import forgeax_material::water_waves::{waterMeshWavePhaseAt}
struct VertexOutput {
  @builtin(position) clip: vec4<f32>, @location(0) original: vec3<f32>,
  @location(1) displaced: vec3<f32>, @location(2) normal: vec3<f32>,
  @location(3) coverage: vec2<f32>,
}
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
  material.maximumFlowVelocityMPerSec = 8.0;
  material.waveVelocityMaskThresholdMPerSec = 1.0;
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let clip = positions[index];
  let coverage = vec2<f32>(clip.x * 1.5 + 2.0, 0.0);
  let original = vec3<f32>(coverage.x + ${mode === 'large-world' ? '100000000.0' : '0.0'}, 6.0, 0.0);
  let deformationInput = waterDeformationInput(0u, 1u, original, original, vec3<f32>(0.6, 0.8, 0.0),
    vec3<f32>(0.0), coverage - vec2<f32>(1.25, 0.0), ${mode === 'far' ? '1u' : '0u'}, vec2<f32>(0.0));
  let deformation = waterMeshFarContinuity(deformationInput, deform_water_vertex(deformationInput), 0u);
  return VertexOutput(vec4<f32>(clip, 0.5, 1.0), original,
    ${mode === 'custom' ? 'original + vec3<f32>(1.25, 2.0, 0.0), vec3<f32>(0.6, 0.8, 0.0)' : 'deformation.currentPositionM, deformation.currentNormalYUp'}, coverage);
}
@fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
  material.maximumFlowVelocityMPerSec = 8.0;
  material.waveVelocityMaskThresholdMPerSec = 1.0;
  var surface: SingleLayerWaterSurfaceInput;
  surface.positionWS = input.displaced;
  surface.originalPositionWS = input.original;
  surface.geometricNormalWS = input.normal;
  surface.originalNormalWS = vec3<f32>(0.0, 1.0, 0.0);
  surface.tangentWS = vec4<f32>(1.0, 0.0, 0.0, 1.0);
  surface.viewDirectionWS = vec3<f32>(0.0, 1.0, 0.0);
  surface.frontFacing = true;
  surface.instanceIndex = 0u;
  surface.wavePhaseXZ = waterMeshWavePhaseAt(0u, input.coverage, input.original.xz);
  return vec4<f32>(evaluate_surface(surface).normalWS, 1.0);
}`,
    {
      WATER_DEFAULT_DEFORMATION_AVAILABLE: mode !== 'custom',
      WATER_TRANSITION_AVAILABLE:
        mode !== 'waves' && mode !== 'large-world' && mode !== 'boundary' && mode !== 'inactive',
      WATER_ENABLE_WAVES: mode === 'waves' || mode === 'large-world' || mode === 'boundary',
      WATER_USE_FIXED_DEPTH: mode === 'large-world',
      WATER_USE_BAKED_SIMULATION: mode !== 'large-world',
      WATER_USE_NORMAL_TEXTURE: false,
      WATER_RIVER: false,
      WATER_OCEAN_FOAM: false,
      WATER_SHADOW_PASS: false,
    },
    extraImports,
  );
  const preparePixelNormalWaterInputs = () => {
    const bytes = bodyBytes();
    if (mode === 'boundary') new Float32Array(bytes.buffer, 112, 4).set([0, 0, 8, 8]);
    new Float32Array(bytes.buffer, WATER_BODY_DATA_STRIDE_BYTES + 32, 4).set([
      mode === 'large-world' ? 100000000 : 1.25,
      0,
      0,
      0,
    ]);
    const descriptors = new Uint8Array(96);
    new Float32Array(descriptors.buffer, 0, 4).set([-2, -2, 1, 1]);
    new Uint32Array(descriptors.buffer, 32, 4).set([11, 5, 0, 1]);
    const samples = new Float32Array(11 * 5 * 4);
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 11; x++) {
        const worldX = x - 2;
        samples.set([4, 0.5 + worldX * 0.5, 0.05 + worldX * 0.12, 0], (y * 11 + x) * 4);
      }
    const tiles = new Uint32Array(24);
    tiles[8] = 2;
    tiles[14] = mode === 'far' ? 1 << 16 : 0;
    tiles[15] = 4;
    tiles[23] = mode === 'boundary' ? 2 : 0;
    new Float32Array(tiles.buffer, 16 * 4, 2).set([-1.25, 0]);
    return { bytes, descriptors, samples, tiles };
  };
  const { bytes, descriptors, samples, tiles } = preparePixelNormalWaterInputs();
  const buffers = {
    body: buffer(bytes),
    waves: buffer(
      new Float32Array([
        0, 1, 20, 20, 0.25, 0.2, 1, 0.625, 0, 0, 0, 0, 1, 0, 2, 20, 0.25, 0.2, 1, 0.625, 0, 0, 0, 0,
      ]),
    ),
    draw: buffer(new Uint32Array([0, 0, 0, 0]), true),
    tiles: buffer(tiles),
    descriptors: buffer(descriptors),
    samples: buffer(samples),
  };
  const target = device.createTexture({
    size: [5, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const resources = new Map<number, GPUBindingResource>([
    [16, { buffer: buffers.body }],
    [17, { buffer: buffers.waves }],
    [21, { buffer: buffers.draw }],
    [22, { buffer: buffers.tiles }],
    [23, { buffer: buffers.descriptors }],
    [24, { buffer: buffers.samples }],
  ]);
  try {
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: compiled.module, entryPoint: 'vs' },
      fragment: { module: compiled.module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
    });
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
    const reads = new Set(
      compiled.entryPoints.flatMap((point) =>
        point.bindings.filter((read) => read.group === 2).map((read) => read.binding),
      ),
    );
    pass.setBindGroup(
      2,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [...reads].map((binding) => {
          const resource = resources.get(binding);
          if (resource === undefined) throw new Error(`Missing production binding 2:${binding}`);
          return { binding, resource };
        }),
      }),
    );
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      [5, 1],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Float32Array(readback.getMappedRange());
    const waveAt = (x: number) => {
      const depth = mode === 'large-world' ? 2 : 0.5 + x * 0.5;
      const attenuation = 1 - Math.exp(-depth / 5);
      const phase = (x - 1.25) * 0.2 - 0.3;
      const normal = [
        Math.sin(phase) * 2 * attenuation * 0.2,
        1 - Math.cos(phase) * 0.25,
        0,
      ] as const;
      const normalLength = Math.hypot(...normal);
      return {
        dx: -0.625 * 2 * attenuation * Math.sin(phase),
        normal: [
          normal[0] / normalLength,
          normal[1] / normalLength,
          normal[2] / normalLength,
        ] as const,
      };
    };
    const vertexDisplacement = (x: number) =>
      waveAt(x).dx * (mode === 'waves' ? 1 : 1 - Math.min(0.05 + x * 0.12, 1));
    for (let x = 0; x < 5; x++) {
      const originalX = 0.8 + x * 0.6;
      const fraction = 0.05 + x * 0.1;
      const postX =
        originalX + vertexDisplacement(0.5) * (1 - fraction) + vertexDisplacement(6.5) * fraction;
      const boundaryBlend = Math.max(0, Math.min(1, (4 - originalX) / 4));
      const weight =
        mode === 'boundary'
          ? boundaryBlend ** 2 * (3 - 2 * boundaryBlend)
          : mode === 'waves' || mode === 'large-world'
            ? 1
            : 1 - Math.min(0.05 + postX * 0.12, 1);
      const normal = waveAt(originalX).normal;
      const expected: readonly [number, number, number] =
        mode === 'custom' || mode === 'far' || mode === 'inactive'
          ? [0.6, 0.8, 0]
          : [normal[0] * weight, 1 + (normal[1] - 1) * weight, 0];
      const expectedLength = Math.hypot(...expected);
      for (const axis of [0, 1, 2] as const)
        expect(pixels[x * 4 + axis], `pixel ${x}/${axis}`).toBeCloseTo(
          expected[axis] / expectedLength,
          5,
        );
    }
    readback.unmap();
  } finally {
    for (const resource of [...Object.values(buffers), target, readback]) resource.destroy();
  }
});

it.each([
  true,
  false,
])('wraps interpolated small tile phase in fragment and preserves non-tiled fallback (tiles=%s)', async (tiled) => {
  const compiled = await compile(
    `
#import forgeax_material::water_waves::{waterMeshWavePhaseAt}
struct VertexOutput { @builtin(position) clip: vec4<f32>, @location(0) coverage: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let clip = positions[index];
  return VertexOutput(vec4<f32>(clip, 0.5, 1.0), vec2<f32>(clip.x * 1.5 + 2.0, 0.25));
}
@fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(waterMeshWavePhaseAt(0u, input.coverage, vec2<f32>(35.25, 2.0)), 0.0, 1.0);
}`,
    {},
  );
  const bytes = bodyBytes();
  for (const offset of [0, WATER_BODY_DATA_STRIDE_BYTES])
    new Float32Array(bytes.buffer, offset + 64, 4).set([10, 0, 0, 0]);
  new Float32Array(bytes.buffer, 32, 4).set([32, -1, 0, 0]);
  new Float32Array(bytes.buffer, WATER_BODY_DATA_STRIDE_BYTES + 48, 4).set([0.75, -0.5, 0, 0]);
  const words = new Uint32Array(24);
  words[8] = 2;
  words[15] = tiled ? 4 : 0;
  new Float32Array(words.buffer, 16 * 4, 2).set([3, -1]);
  const body = buffer(bytes);
  const tiles = buffer(words);
  const draw = buffer(new Uint32Array([0, 0, 0, 0]), true);
  const target = device.createTexture({
    size: [5, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: compiled.module, entryPoint: 'vs' },
      fragment: { module: compiled.module, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
    });
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
      2,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [
          { binding: 16, resource: { buffer: body } },
          { binding: 21, resource: { buffer: draw } },
          { binding: 22, resource: { buffer: tiles } },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      [5, 1],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Float32Array(readback.getMappedRange());
    for (let x = 0; x < 5; x++) {
      const relative = 0.8 + x * 0.6 + 3 + 0.75;
      const expected = tiled ? relative - Math.floor((relative + 5) / 10) * 10 : 3.25;
      expect(pixels[x * 4], `pixel ${x} phase X`).toBeCloseTo(expected, 5);
      expect(pixels[x * 4 + 1], `pixel ${x} phase Z`).toBeCloseTo(tiled ? -1.25 : 3, 5);
    }
    readback.unmap();
  } finally {
    for (const resource of [body, tiles, draw, target, readback]) resource.destroy();
  }
});

it.each([
  true,
  false,
])('clips interpolated post-WPO fragments without WaterInfo RT (Info=%s)', async (info) => {
  const compiled = await compile(
    `
#import forgeax_material::water_waves::{waterDynamicBoundsContains}
struct VertexOutput { @builtin(position) clip: vec4<f32>, @location(0) positionWS: vec3<f32> }
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let position = positions[index];
  return VertexOutput(vec4<f32>(position, 0.5, 1.0), vec3<f32>(position.x * 2.5, 0.0, position.y * 2.5));
}
@fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
  if (!waterDynamicBoundsContains(0u, input.positionWS)) { discard; }
  return vec4<f32>(1.0);
}`,
    { WATER_USE_INFO: info },
  );
  expect(
    compiled.entryPoints
      .flatMap((point) => point.bindings)
      .some((read) => read.group === 2 && [18, 19, 20].includes(read.binding)),
  ).toBe(false);
  const bytes = bodyBytes();
  new Float32Array(bytes.buffer, 112, 4).set([0, 0, 2.2, 2.2]);
  const body = buffer(bytes);
  const target = device.createTexture({
    size: [5, 5],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 5 * 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: compiled.module, entryPoint: 'vs' },
      fragment: { module: compiled.module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
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
      2,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [{ binding: 16, resource: { buffer: body } }],
      }),
    );
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      [5, 5],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(readback.getMappedRange());
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++) {
        const inside = x >= 1 && x <= 3 && y >= 1 && y <= 3;
        const expected = info ? inside : !inside;
        expect(pixels[y * 256 + x * 4], `pixel ${x},${y}`).toBe(expected ? 255 : 0);
      }
    readback.unmap();
  } finally {
    body.destroy();
    target.destroy();
    readback.destroy();
  }
});

it.each([
  true,
  false,
])('preserves exact rectangle edges and unbound-Zone bypass (Info=%s)', async (info) => {
  const compiled = await compile(
    `
#import forgeax_material::water_waves::{waterDynamicBoundsContains}
@group(0) @binding(0) var<storage, read_write> result: array<vec2<u32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  var position = vec3<f32>(f32(id.x % 3u) - 1.0, 0.0, f32(id.x / 3u) - 1.0);
  if (id.x == 9u) { position = vec3<f32>(2.0, 0.0, 0.0); }
  result[id.x] = vec2<u32>(u32(waterDynamicBoundsContains(0u, position)), u32(waterDynamicBoundsContains(1u, position)));
}`,
    { WATER_USE_INFO: info },
  );
  const bytes = bodyBytes();
  new Float32Array(bytes.buffer, WATER_BODY_DATA_STRIDE_BYTES + 112, 4).fill(0);
  const body = buffer(bytes);
  const output = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: compiled.module, entryPoint: 'main' },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: output } }],
      }),
    );
    pass.setBindGroup(
      2,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [{ binding: 16, resource: { buffer: body } }],
      }),
    );
    pass.dispatchWorkgroups(10);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 80);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Uint32Array(readback.getMappedRange());
    for (let index = 0; index < 10; index++) {
      expect(values[index * 2]).toBe(info ? Number(index < 9) : Number(index !== 4));
      expect(values[index * 2 + 1]).toBe(1);
    }
    readback.unmap();
  } finally {
    body.destroy();
    output.destroy();
    readback.destroy();
  }
});
