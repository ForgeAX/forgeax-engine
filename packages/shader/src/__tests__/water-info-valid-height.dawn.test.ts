import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';

it('WaterInfo material sampling keeps raw B while vertex mapping excludes invalid heights', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WaterInfo height regression requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const positions = new Float32Array([
    -0.5, -0.5, -0.25, -0.5, 0, -0.5, 0.5, -0.5, 0, 0.5, -0.25, 0,
  ]);
  const input = device.createBuffer({
    size: positions.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: positions.length * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: positions.length * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const descriptor = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const body = device.createBuffer({
    size: 128,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(body, 96, new Uint32Array([2, 0, 0, 0]));
  const info = device.createTexture({
    size: [2, 2, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  try {
    const source = readFileSync(new URL('../water-waves.wgsl', import.meta.url), 'utf8');
    const code = await composeShader(
      `
#import forgeax_material::water_waves::{waterInfoSampleAt, waterInfoHeightDepth, waterHeightMappingVS, waterWaveDepthAt}
@group(0) @binding(0) var<storage, read> positions: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&positions)) { return; }
  let worldXZ = positions[id.x];
  let sample = waterInfoSampleAt(worldXZ);
  let height = waterInfoHeightDepth(worldXZ);
  let mapped = waterHeightMappingVS(0u, vec3<f32>(worldXZ.x, 100.0, worldXZ.y), vec3<f32>(0.0));
  let waveDepth = waterWaveDepthAt(0u, worldXZ, vec3<f32>(0.0));
  result[id.x * 2u] = vec4<f32>(sample.z, height.x, height.z, sample.x);
  result[id.x * 2u + 1u] = vec4<f32>(mapped.worldPositionM.y, waveDepth, height.y);
}`,
      { 'forgeax_material::water_waves': source },
      {
        WATER_USE_INFO: true,
        WATER_USE_BAKED_SIMULATION: false,
        WATER_USE_FIXED_HEIGHT: false,
        WATER_USE_FIXED_DEPTH: false,
        WATER_USE_FIXED_VELOCITY: false,
        WATER_DYNAMIC_BOUNDS_CLIP: false,
        WATER_BAKED_HEIGHT_DEPTH_AVAILABLE: false,
      },
    );
    const module = device.createShaderModule({ code });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const descriptorBytes = new ArrayBuffer(48);
    const descriptorView = new DataView(descriptorBytes);
    descriptorView.setUint32(4, 2, true);
    descriptorView.setUint32(8, 2, true);
    descriptorView.setFloat32(16, -3, true);
    descriptorView.setFloat32(20, 3.3, true);
    descriptorView.setFloat32(24, -33, true);
    descriptorView.setFloat32(40, 2, true);
    descriptorView.setFloat32(44, 2, true);
    device.queue.writeBuffer(descriptor, 0, descriptorBytes);
    device.queue.writeBuffer(input, 0, positions);
    device.queue.writeTexture(
      { texture: info },
      new Float32Array([0, 0, 0, 0, 1, 0, 0.5, 0, 0, 0, 0.4, 0, 1, 0, 0.6, 0]),
      { bytesPerRow: 32 },
      [2, 2, 1],
    );
    const dataGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const infoGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(2),
      entries: [
        { binding: 16, resource: { buffer: body } },
        { binding: 18, resource: info.createView({ dimension: '2d-array' }) },
        { binding: 20, resource: { buffer: descriptor } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, dataGroup);
    pass.setBindGroup(2, infoGroup);
    pass.dispatchWorkgroups(positions.length / 2);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, positions.length * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    const sample = (index: number) => Array.from(values.subarray(index * 8, index * 8 + 4));
    const mapping = (index: number) => Array.from(values.subarray(index * 8 + 4, index * 8 + 8));
    expect(sample(0)[0]).toBe(0);
    expect(sample(0)[1]).toBeCloseTo(-35.56, 4);
    expect(sample(0)[2]).toBe(0);
    expect(mapping(0)[0]).toBe(100);
    expect(sample(1)[0]).toBeCloseTo(0.125, 6);
    expect(sample(1)[1]).toBeCloseTo(-2.2125, 5);
    expect(sample(1)[2]).toBe(1);
    expect(sample(1)[3]).toBeCloseTo(0.25, 6);
    expect(sample(2)[0]).toBeCloseTo(0.25, 6);
    expect(sample(3)[0]).toBeCloseTo(0.5, 6);
    expect(sample(4)[0]).toBeCloseTo(0.5, 6);
    expect(sample(5)[0]).toBeCloseTo(0.2875, 5);
    expect(mapping(1)[0]).toBeCloseTo(0.15, 5);
    expect(mapping(2)[0]).toBeCloseTo(0.15, 5);
    expect(mapping(5)[0]).toBeCloseTo(-0.102, 5);
    for (let index = 0; index < positions.length / 2; index++) {
      expect(mapping(index)[1]).toBeCloseTo(Math.max((sample(index)[1] ?? Number.NaN) + 33, 0), 4);
      expect(mapping(index)[2]).toBe(sample(index)[2]);
      expect(mapping(index)[3]).toBe(mapping(index)[1]);
    }
    expect(errors).toEqual([]);
    readback.unmap();
  } finally {
    info.destroy();
    descriptor.destroy();
    body.destroy();
    readback.destroy();
    output.destroy();
    input.destroy();
    device.destroy();
  }
});
