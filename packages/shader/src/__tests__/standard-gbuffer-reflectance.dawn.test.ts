import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('reconstructs independent F0/F90/AO without reading reserved normal bits', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('GBuffer reflectance requires a GPU adapter');
  const device = await adapter.requestDevice();
  const pack = (bytes: readonly number[]) =>
    bytes.reduce((value, byte, i) => value | (byte << (i * 8)), 0) >>> 0;
  const cases: { albedo: readonly number[]; dielectric: readonly number[]; ao: number }[] = [];
  for (const metallic of [0, 1, 127, 254, 255]) {
    for (const f90 of [0, 64, 128, 255]) {
      for (const rgb of [
        [36, 36, 36],
        [0, 64, 180],
        [255, 1, 0],
      ]) {
        for (const ao of [0, 127, 255])
          cases.push({ albedo: [192, 64, 128, metallic], dielectric: [...rgb, f90], ao });
      }
    }
  }
  // Reserved high bits cannot change the independent roughness/AO word.
  const input = new Uint32Array(cases.length * 2 * 4);
  cases.forEach((value, i) => {
    for (let lane = 0; lane < 2; lane++)
      input.set(
        [
          ((lane === 0 ? 0xffff0000 : 0) | (value.ao << 8) | 127) >>> 0,
          pack(value.dielectric),
          pack(value.albedo),
          0,
        ],
        (i * 2 + lane) * 4,
      );
  });
  const source = device.createBuffer({
    size: input.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: cases.length * 2 * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const codec = readFileSync(
      new URL('../standard-gbuffer.wgsl', import.meta.url),
      'utf8',
    ).replace(/^#define_import_path[^\n]*\n/m, '');
    const module = device.createShaderModule({
      code: `${codec}
struct Result { response: vec4f, dielectric: vec4f }
@group(0) @binding(0) var<storage, read> source: array<vec4u>;
@group(0) @binding(1) var<storage, read_write> output: array<Result>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&source)) { return; }
  let value = source[id.x];
  let decoded = decodeStandardGBufferReflectance(decodeStandardReflectance(value.z), value.y, vec2u(0x40000000u, value.x));
  output[id.x] = Result(decoded.response, decoded.dielectricSpecular);
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
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    device.queue.writeBuffer(source, 0, input);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(Math.ceil((cases.length * 2) / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    cases.forEach((value, i) => {
      const metal = (value.albedo[3] ?? NaN) / 255;
      for (let lane = 0; lane < 2; lane++) {
        const base = (i * 2 + lane) * 8;
        for (let channel = 0; channel < 3; channel++) {
          const dielectric = ((value.dielectric[channel] ?? NaN) / 255) ** 2;
          const albedo = ((value.albedo[channel] ?? NaN) / 255) ** 2;
          expect(
            Math.abs((values[base + channel] ?? NaN) - (dielectric * (1 - metal) + albedo * metal)),
          ).toBeLessThan(5e-7);
          expect(Math.abs((values[base + 4 + channel] ?? NaN) - dielectric)).toBeLessThan(5e-7);
        }
        expect(Math.abs((values[base + 3] ?? NaN) - value.ao / 255)).toBeLessThan(5e-7);
        expect(
          Math.abs((values[base + 7] ?? NaN) - (value.dielectric[3] ?? NaN) / 255),
        ).toBeLessThan(5e-7);
      }
      expect(Array.from(values.subarray(i * 16, i * 16 + 8))).toEqual(
        Array.from(values.subarray(i * 16 + 8, i * 16 + 16)),
      );
    });
    readback.unmap();
  } finally {
    source.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
