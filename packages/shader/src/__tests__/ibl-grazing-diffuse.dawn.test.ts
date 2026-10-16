import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const functionSource = (file: string, name: string) => {
  const body = source(file).match(new RegExp(`fn ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
  if (!body) throw new Error(`Missing shader function ${name}`);
  return body;
};

// Execute the actual Standard ambient coefficient, including its canonical
// Fresnel helpers, rather than a CPU mirror of the proposed correction.
it.each([
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
])('%s retains rough dielectric diffuse energy at grazing angles', async (file) => {
  expect(source(file)).toContain('evaluateStandardEnvironment');
  const coefficient = source('standard-lighting.wgsl').match(
    /let fresnel = [\s\S]*?let kD = [\s\S]*?;/,
  )?.[0];
  expect(coefficient).toBeDefined();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn ambient regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  const output = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const module = device.createShaderModule({
      code: `
        ${functionSource('brdf.wgsl', 'specularF90')}
        ${functionSource('brdf.wgsl', 'f_schlick')}
        ${functionSource('ibl-shared.wgsl', 'fresnelSchlickRoughness')}
        ${functionSource('ibl-shared.wgsl', 'standardDiffuseWeight')}
        @group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>, 4>;
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let normal = vec3<f32>(0.0, 1.0, 0.0);
          let cosine = select(0.001, 1.0, id.x == 1u);
          let direction = vec3<f32>(sqrt(1.0 - cosine * cosine), cosine, 0.0);
          let f0 = vec3<f32>(0.04);
          let metallic = select(0.0, 1.0, id.x == 3u);
          let roughness = select(0.95, 0.04, id.x == 2u);
          ${coefficient}
          result[id.x] = vec4<f32>(kD, 1.0);
        }`,
    });
    const compilation = await module.getCompilationInfo();
    expect(
      compilation.messages
        .filter((message) => message.type === 'error')
        .map(({ message, lineNum, linePos }) => ({ message, lineNum, linePos })),
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
    pass.dispatchWorkgroups(4);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 64);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    expect(values.every(Number.isFinite)).toBe(true);
    expect(values[0]).toBeGreaterThan(0.9);
    expect(values[4]).toBeCloseTo(0.96, 3);
    expect(values[8]).toBeLessThan(0.06);
    expect(values[12]).toBe(0);
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});

// Cover the full angle/roughness range on the actual backend, including clamp
// endpoints and colored F0. Keep the reference expression independent of the
// optimized implementation so floating-point drift remains observable.
it('roughness Fresnel retains the fifth-power reference across its domain', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn Fresnel regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  const count = 33 * 33;
  const bytes = count * 16;
  const output = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const module = device.createShaderModule({
      code: `
      ${functionSource('brdf.wgsl', 'specularF90')}
      ${functionSource('ibl-shared.wgsl', 'fresnelSchlickRoughness')}
      @group(0) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let cosine = (f32(id.x % 33u) - 1.0) / 30.0;
        let roughness = f32(id.x / 33u) / 32.0;
        let f0 = vec3<f32>(0.0, 0.04, 0.95);
        let reference = f0 + (max(vec3<f32>(1.0 - roughness), f0) - f0)
          * pow(clamp(1.0 - cosine, 0.0, 1.0), 5.0);
        let actual = fresnelSchlickRoughness(cosine, f0, roughness);
        result[id.x] = vec4<f32>(actual - reference, 1.0);
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
    pass.dispatchWorkgroups(count);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    for (const [i, value] of values.entries()) {
      expect(Number.isFinite(value)).toBe(true);
      if (i % 4 === 3) expect(value).toBe(1);
      else expect(Math.abs(value)).toBeLessThan(0.000002);
    }
    readback.unmap();
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
