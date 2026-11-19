import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const surface = readFileSync(new URL('../water-surface.wgsl', import.meta.url), 'utf8');
const slw = readFileSync(new URL('../single-layer-water.wgsl', import.meta.url), 'utf8');
const temporal = readFileSync(new URL('../scene-temporal.wgsl', import.meta.url), 'utf8');
const functionSource = (source: string, name: string) => {
  const match = new RegExp(`fn ${name}\\([\\s\\S]*?\\n\\}`).exec(source)?.[0];
  if (!match) throw new Error(`Missing production ${name}`);
  return match;
};
const depthProducer = /surface\.sceneDepthWithoutWaterM = select\([\s\S]*?;/.exec(slw)?.[0];
const depthFoam = / {2}let depthHit = [\s\S]*? {2}let depthFoam = [\s\S]*?;/.exec(surface)?.[0];
if (!depthProducer || !depthFoam) throw new Error('Missing production scene-depth foam path');

it('uses actual perspective and orthographic depth hits and rejects clear, foreground and back faces', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Scene-depth foam requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const cases = [
    { scene: 10.25, water: 10, front: true, hit: true },
    { scene: 0, water: 10, front: true, hit: false },
    { scene: 9, water: 10, front: true, hit: false },
    { scene: 10, water: 10, front: true, hit: false },
    { scene: 15, water: 10, front: true, hit: true },
    { scene: 1, water: 1, front: true, hit: false },
    { scene: 50, water: 50, front: true, hit: false },
    { scene: 10.001, water: 10, front: true, hit: true },
    { scene: 50.001, water: 50, front: true, hit: true },
    { scene: 10.25, water: 10, front: false, hit: false },
    { scene: 1.25, water: 1, front: true, hit: true },
  ];
  const samples = new Float32Array(
    [false, true].flatMap((orthographic) =>
      cases.flatMap((sample) => [
        sample.scene === 0
          ? 0
          : orthographic
            ? (100 - sample.scene) / 99
            : (100 / sample.scene - 1) / 99,
        sample.water,
        Number(sample.front),
        Number(orthographic),
      ]),
    ),
  );
  const source = device.createBuffer({
    size: samples.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: samples.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: samples.byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  let actual: number[] = [];
  try {
    device.queue.writeBuffer(source, 0, samples);
    const module = device.createShaderModule({
      code: `
struct View { inverseViewProj: mat4x4<f32>, worldViewProj: mat4x4<f32>, temporalProjection: vec4<f32> }
struct Surface { sceneDepthWithoutWaterM: f32 }
struct Input { frontFacing: bool, sceneDepthWithoutWaterM: f32, pixelDepthM: f32 }
struct Material { sceneDepthFoamWidthM: f32, sceneDepthFoamAmount: f32 }
var<private> view: View;
@group(0) @binding(0) var<storage, read> samples: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4<f32>>;
${functionSource(temporal, 'sceneViewZ')}
${functionSource(slw, 'waterWorld')}
${functionSource(slw, 'waterViewDepth')}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let sample = samples[id.x];
  view.temporalProjection = vec4<f32>(1.0, 100.0, sample.w, 0.0);
  view.worldViewProj = mat4x4<f32>(vec4<f32>(1.0,0.0,0.0,0.0), vec4<f32>(0.0,1.0,0.0,0.0),
    vec4<f32>(0.0,0.0,1.0/99.0,-1.0), vec4<f32>(0.0,0.0,100.0/99.0,0.0));
  view.inverseViewProj = mat4x4<f32>(vec4<f32>(1.0,0.0,0.0,0.0), vec4<f32>(0.0,1.0,0.0,0.0),
    vec4<f32>(0.0,0.0,0.0,0.99), vec4<f32>(0.0,0.0,-1.0,0.01));
  if (sample.w > 0.5) {
    view.worldViewProj[2] = vec4<f32>(0.0,0.0,1.0/99.0,0.0);
    view.worldViewProj[3] = vec4<f32>(0.0,0.0,100.0/99.0,1.0);
    view.inverseViewProj[2] = vec4<f32>(0.0,0.0,99.0,0.0);
    view.inverseViewProj[3] = vec4<f32>(0.0,0.0,-100.0,1.0);
  }
  let sceneUv = vec2<f32>(0.5);
  let sceneRawDepth = sample.x;
  var surface = Surface(0.0);
  ${depthProducer}
  let input = Input(sample.z > 0.5, surface.sceneDepthWithoutWaterM, sample.y);
  let material = Material(1.2, 1.2);
  ${depthFoam}
  result[id.x] = vec4<f32>(surface.sceneDepthWithoutWaterM, select(0.0, 1.0, depthHit), depthFoam, 1.0);
}`,
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const binding = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binding);
    pass.dispatchWorkgroups(cases.length * 2);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, samples.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    actual = Array.from(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    for (let index = 0; index < cases.length * 2; index++) {
      const sample = requiredFixtureValue(cases[index % cases.length]);
      expect(actual[index * 4]).toBeCloseTo(sample.scene || 100, 4);
      expect(actual[index * 4 + 1]).toBe(Number(sample.hit));
      const clearance = Math.max(0, Math.min(1, (sample.scene - sample.water) / 1.2));
      const expected = sample.hit ? (1 - clearance * clearance * (3 - 2 * clearance)) * 1.2 : 0;
      expect(actual[index * 4 + 2]).toBeCloseTo(expected, 4);
    }
  } finally {
    const validation = (await device.popErrorScope())?.message ?? null;
    source.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
    console.info('[water-scene-depth-foam]', JSON.stringify({ actual, validation, errors }));
    expect(validation).toBeNull();
    expect(errors).toEqual([]);
  }
});

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Required native fixture value is absent');
  return value;
}
