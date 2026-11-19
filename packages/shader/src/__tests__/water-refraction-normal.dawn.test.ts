import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('stock Water underside parameters remain independent of specular', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Water underside regression requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const source = readFileSync(new URL('../water-surface.wgsl', import.meta.url), 'utf8');
  const start = source.indexOf('  let critical =');
  const end = source.indexOf('  // Saturation in WaterOpacityMaskFromDepth', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const samples = new Float32Array(
    [
      // Specular, threshold, bottom amount, NoV; facing, pixel depth, unused, unused.
      [0.225, 0.225, 1, 0.4, 0, 0, 0, 0],
      [0.8, 0.225, 1, 0.4, 0, 0, 0, 0],
      [0.8, 0.5, 1, 0.4, 0, 0, 0, 0],
      [0.225, 0.225, 0, 1, 0, 0, 0, 0],
      [0.225, 0.225, 0.25, 1, 0, 0, 0, 0],
      [0.8, 0.5, 0, 0.4, 1, 0, 0, 0],
      [0.225, 0.225, 0.25, 1, 0, 25, 0, 0],
    ].flat(),
  );
  const sampleBuffer = device.createBuffer({
    size: samples.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: 7 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 7 * 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(sampleBuffer, 0, samples);
    const module = device.createShaderModule({
      code: `
struct Sample { parameters: vec4<f32>, view: vec4<f32> }
struct Material {
  specular: f32, criticalAngleDot: f32, criticalAngleWidth: f32,
  criticalAngleBendWidth: f32, refractionBottomAmount: f32,
  refractionPixelNormalStrength: f32, distantRefractionPixelNormalStrength: f32,
  refractionDistanceM: f32, lipRefraction: f32,
}
struct Input { pixelDepthM: f32 }
@group(0) @binding(0) var<storage, read> samples: array<Sample>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let sample = samples[id.x];
  let material = Material(sample.parameters.x, sample.parameters.y, 0.01, -0.75,
    sample.parameters.z, 1.15, 1.02, 50.0, 0.95);
  let input = Input(sample.view.y);
  let normalDotCamera = sample.parameters.w;
  let facing = sample.view.x;
${source.slice(start, end)}
  result[id.x] = vec4<f32>(undersideOpacity, undersideSpecular, undersideRefraction, 1.0);
}`,
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sampleBuffer } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(7);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 7 * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    const expected = [
      [0, 0.225, 0.9966666666666666],
      [0, 0.8, 0.9966666666666666],
      [1, 1, 0.95],
      [0, 0.225, 1],
      [0, 0.225, 1.0375],
      [0, 0.8, 1.15],
      [0, 0.225, 1.02125],
    ];
    for (const [index, result] of expected.entries())
      for (const [axis, value] of result.entries())
        expect(values[index * 4 + axis], `sample ${index}, axis ${axis}`).toBeCloseTo(value, 6);
    expect(errors).toEqual([]);
    readback.unmap();
  } finally {
    sampleBuffer.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});

it('legacy two-sided Water PNO retains the unflipped original tangent basis', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Water refraction regression requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const source = readFileSync(new URL('../single-layer-water.wgsl', import.meta.url), 'utf8');
  const color = source.slice(source.indexOf('fn waterColor('));
  const normalStart = color.indexOf('  let normal =');
  const normal = color.slice(normalStart, color.indexOf('\n', normalStart));
  const refractionStart = color.indexOf('  let rightRow =');
  const refractionEnd = color.indexOf('  let thicknessM =', refractionStart);
  expect(normalStart).toBeGreaterThan(0);
  expect(refractionEnd).toBeGreaterThan(refractionStart);
  // Execute the production normal and PNO expressions, including their face selection.
  const refraction = color.slice(refractionStart, refractionEnd);
  const output = device.createBuffer({
    size: 6 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 6 * 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const module = device.createShaderModule({
      code: `
struct Surface { normalWS: vec3<f32>, refractionPixelNormalStrength: f32 }
struct Input { originalNormalWS: vec3<f32> }
struct View { temporalCurrentViewProj: mat4x4<f32>, viewportWidth: f32, viewportHeight: f32 }
@group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let frontFacing = id.x % 2u == 0u;
  let perturbed = select(vec3<f32>(0.0, 1.0, 0.0), normalize(vec3<f32>(0.2, 1.0, -0.1)), id.x >= 2u);
  let surface = Surface(perturbed, select(1.1, 1.0, id.x >= 4u));
  let input = Input(vec3<f32>(0.0, 1.0, 0.0));
  let view = View(mat4x4<f32>(vec4<f32>(1.36, 0.66, 0.0, 0.0), vec4<f32>(0.0, 1.905255888, 0.0, 0.0), vec4<f32>(-1.02, 0.88, 1.0, 0.0), vec4<f32>(0.0, 0.0, 0.0, 1.0)), 1600.0, 938.0);
${normal}
${refraction}
  result[id.x] = vec4<f32>(bufferOffset, length(normalDelta), 1.0);
}`,
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(6);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 6 * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    // Compare the original TBN +Z with the signed final world normal.
    // Back-face orientation flips only the latter.
    const expected = [
      [0, 0],
      [0, -0.08220798106948012],
      [-0.013431507884005253, -0.00006422417376458874],
      [0.013431507884005253, -0.08214375689571553],
      [0, 0],
      [0, 0],
    ];
    for (const [index, offset] of expected.entries())
      for (const [axis, value] of offset.entries())
        expect(values[index * 4 + axis]).toBeCloseTo(value, 6);
    expect(errors).toEqual([]);
    readback.unmap();
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
