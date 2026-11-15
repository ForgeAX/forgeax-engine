import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';
import {
  buildWaterWaveUploadPlan,
  cookGerstnerWaveSet,
  evaluateGerstnerWavesGpuForward,
  WATER_WAVE_LWC_TILE_LENGTH_M,
} from '../../../water/src/waves';

const largeHigh = Math.fround(WATER_WAVE_LWC_TILE_LENGTH_M * 4096);
const cases = [
  {
    name: 'captured waterline point',
    bodyOrigin: [0, 0],
    viewOrigin: [0, 0.04, 10],
    worldXZ: [0.0001068115234375, 9.9000244140625],
    phaseXZ: [0.0001068115234375, 9.9000244140625],
  },
  {
    name: 'independent camera and body origins',
    bodyOrigin: [35, -12],
    viewOrigin: [12, 5, -40],
    worldXZ: [0.0001068115234375, 9.9000244140625],
    phaseXZ: [0.0001068115234375, 9.9000244140625],
  },
  {
    name: 'large split body origin',
    bodyOrigin: [
      WATER_WAVE_LWC_TILE_LENGTH_M * 4096 + 40.5,
      -WATER_WAVE_LWC_TILE_LENGTH_M * 4096 + 31.25,
    ],
    viewOrigin: [largeHigh + 16, 2, -largeHigh - 16],
    worldXZ: [largeHigh + 24, -largeHigh - 32],
    phaseXZ: [24, -32],
  },
] as const;

it('uses the serialized underwater material Schlick phase with raw anisotropy', async () => {
  const source = readFileSync(new URL('../water-underwater.wgsl', import.meta.url), 'utf8');
  const start = source.indexOf('  let g = material.underwaterPhaseG;');
  const end = source.indexOf('  let scatter =', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const samples = [0, 0.3, -0.4, 0.8].flatMap((g) =>
    [-0.9, 0, 0.7].map((cosine) => ({ g, cosine })),
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Underwater phase regression requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const size = samples.length * 16;
  const output = device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const module = device.createShaderModule({
      code: `
struct Material { underwaterPhaseG: f32 };
struct View { direction: vec3<f32> };
fn view_atmosphere_light_direction(v: View) -> vec3<f32> { return v.direction; }
@group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let samples = array<vec2<f32>, ${samples.length}>(${samples.map(({ g, cosine }) => `vec2<f32>(${g}, ${cosine})`).join(', ')});
  let material = Material(samples[id.x].x);
  let view = View(vec3<f32>(1.0, 0.0, 0.0));
  let toCamera = vec3<f32>(samples[id.x].y, sqrt(1.0 - samples[id.x].y * samples[id.x].y), 0.0);
${source.slice(start, end)}
  result[id.x] = vec4<f32>(phase, 0.0, 0.0, 1.0);
}`,
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(samples.length);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    expect(errors).toEqual([]);
    for (const [index, { g, cosine }] of samples.entries()) {
      // The serialized Engine SchlickPhase material wires Anisotropy directly to k.
      const expected = (1 - g * g) / (4 * Math.PI * (1 + g * cosine) ** 2);
      expect(actual[index * 4]).toBeCloseTo(expected, 6);
    }
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});

it.each(
  cases.flatMap((entry) => [0.05, 0.1, 0.5, 4.5].map((depthM) => ({ ...entry, depthM }))),
)('Underwater waves retain depth attenuation and body phase for $name at $depthM m', async ({
  bodyOrigin,
  viewOrigin,
  worldXZ,
  phaseXZ,
  depthM,
}) => {
  const cooked = cookGerstnerWaveSet({
    kind: 'water-wave-set',
    sourceMode: 'predefined',
    waves: [
      { directionXZ: [0.8, 0.6], amplitudeM: 0.12, wavelengthM: 8, steepness: 0.08 },
      {
        directionXZ: [-0.3, Math.sqrt(0.91)],
        amplitudeM: 0.045,
        wavelengthM: 3.5,
        steepness: 0.06,
      },
    ],
    inputDigest: 'a'.repeat(64),
    depthMaskM: 2,
    maxWaveHeightM: 0.2,
    timeSource: 'scene-clock',
  });
  if (!cooked.ok) throw cooked.error;
  const currentTime = Math.fround(20.976600646972656);
  const previousTime = Math.fround(20.91);
  const plan = buildWaterWaveUploadPlan([
    {
      worldId: 1,
      worldIdentity: 'phase-test-world',
      bodyGuid: 'body',
      waveSetGuid: 'waves',
      bodyGeneration: 1,
      zoneGeneration: 1,
      waveSet: cooked.value,
      timeSeconds: currentTime,
      previousTimeSeconds: previousTime,
      baseHeightM: 0,
      tileOriginWorldXZ: bodyOrigin,
      tileLengthM: WATER_WAVE_LWC_TILE_LENGTH_M,
      heightSource: {
        kind: 'fixed',
        fixedHeightM: 0,
        fixedDepthM: depthM,
        fixedVelocityXZ: [0, 0],
      },
      supportsWaves: true,
      usesFlatSurfaceHeight: true,
      meshEdgeOverlayEnabled: false,
    },
  ]);
  if (!plan.ok) throw plan.error;
  const pp = readFileSync(new URL('../water-underwater.wgsl', import.meta.url), 'utf8');
  const velocityStart = pp.indexOf('  let velocity =');
  const coordinateStart = pp.indexOf('\n', velocityStart) + 1;
  const coordinateEnd = pp.indexOf('  let waveMask =', coordinateStart);
  expect(coordinateStart).toBeGreaterThan(0);
  expect(coordinateEnd).toBeGreaterThan(coordinateStart);
  const coordinates = pp.slice(coordinateStart, coordinateEnd);
  const imports = pp.match(/^#import forgeax_material::water_waves::\{.*\}$/m)?.[0];
  if (!imports) throw new Error('Underwater production Water imports are missing');
  const code = await composeShader(
    `
${imports}
@group(0) @binding(0) var<uniform> nearPoint: vec4<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn main() {
  let bodyIndex = waterMaterialDrawData.bodyIndex;
  let body = waterBodyData[bodyIndex];
  let heightDepth = waterBodyHeightDepth(bodyIndex, nearPoint.xz, vec3<f32>(0.0));
${coordinates}
  result[0] = vec4<f32>(wave.displacement, 1.0);
  result[1] = vec4<f32>(wave.normal, 1.0);
  result[2] = vec4<f32>(wave.velocity, 1.0);
  {
${coordinates.replace('body.timeAndMask.x', 'body.timeAndMask.y')}
    result[3] = vec4<f32>(wave.displacement, 1.0);
    result[4] = vec4<f32>(wave.normal, 1.0);
    result[5] = vec4<f32>(wave.velocity, 1.0);
  }
}`,
    {
      'forgeax_material::water_waves': readFileSync(
        new URL('../water-waves.wgsl', import.meta.url),
        'utf8',
      ),
    },
    {
      WATER_DYNAMIC_BOUNDS_CLIP: false,
      WATER_USE_FIXED_VELOCITY: false,
      WATER_USE_BAKED_SIMULATION: false,
      WATER_USE_INFO: false,
      WATER_USE_FIXED_HEIGHT: false,
      WATER_USE_FIXED_DEPTH: false,
      WATER_BAKED_HEIGHT_DEPTH_AVAILABLE: false,
    },
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Underwater phase regression requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffers: GPUBuffer[] = [];
  const buffer = (bytes: Uint8Array, usage: GPUBufferUsageFlags) => {
    const created = device.createBuffer({
      size: bytes.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    buffers.push(created);
    device.queue.writeBuffer(created, 0, bytes);
    return created;
  };
  const point = buffer(
    new Uint8Array(new Float32Array([worldXZ[0], 0, worldXZ[1], 0]).buffer),
    GPUBufferUsage.UNIFORM,
  );
  const body = buffer(plan.value.bodyBuffer, GPUBufferUsage.STORAGE);
  const waves = buffer(plan.value.waveBuffer, GPUBufferUsage.STORAGE);
  const draw = buffer(
    new Uint8Array(new Float32Array([0, ...viewOrigin]).buffer),
    GPUBufferUsage.UNIFORM,
  );
  const output = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  buffers.push(output, readback);
  try {
    const module = device.createShaderModule({ code });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const inputs = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: point } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const water = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(2),
      entries: [
        { binding: 16, resource: { buffer: body } },
        { binding: 17, resource: { buffer: waves } },
        { binding: 21, resource: { buffer: draw } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, inputs);
    pass.setBindGroup(2, water);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 96);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange());
    for (const [index, timeSeconds] of [currentTime, previousTime].entries()) {
      const expected = evaluateGerstnerWavesGpuForward({
        waves: cooked.value.waves,
        positionXZ: phaseXZ,
        timeSeconds,
        depthM,
        depthMaskM: 2,
      });
      for (const [component, vector] of [
        expected.displacementM,
        expected.normalYUp,
        expected.velocityMPerSec,
      ].entries())
        for (let axis = 0; axis < 3; axis++)
          expect(actual[index * 12 + component * 4 + axis]).toBeCloseTo(vector[axis], 5);
    }
    expect(errors).toEqual([]);
    readback.unmap();
  } finally {
    for (const created of buffers) created.destroy();
    device.destroy();
  }
});
