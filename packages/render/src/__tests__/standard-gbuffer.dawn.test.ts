import { expect, it } from 'vitest';
import gbufferSource from '../../../shader/src/standard-gbuffer.wgsl?raw';

it('bounds packed normal, roughness and dark colored reflectance error on the GPU', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const count = 1024;
  const input = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * i) / (count - 1);
    const radius = Math.sqrt(1 - z * z);
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const fraction = i / (count - 1);
    input.set(
      [
        radius * Math.cos(angle),
        radius * Math.sin(angle),
        z,
        fraction,
        fraction ** 4,
        fraction ** 2,
        fraction,
        1 - fraction,
      ],
      i * 8,
    );
  }
  const source = device.createBuffer({
    size: input.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    size: input.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: input.byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const module = device.createShaderModule({
      code: `
      ${gbufferSource.replace(/^#define_import_path[^\n]*\n/m, '')}
      struct Sample { normalRoughness: vec4f, reflectanceScalar: vec4f };
      @group(0) @binding(0) var<storage, read> source: array<Sample>;
      @group(0) @binding(1) var<storage, read_write> output: array<Sample>;
      @compute @workgroup_size(64)
      fn roundtrip(@builtin(global_invocation_id) id: vec3u) {
        let value = source[id.x];
        output[id.x] = Sample(
          decodeStandardNormalRoughness(encodeStandardNormalRoughness(value.normalRoughness.xyz, value.normalRoughness.w)),
          decodeStandardReflectance(encodeStandardReflectance(value.reflectanceScalar.xyz, value.reflectanceScalar.w)));
      }
    `,
    });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'roundtrip' },
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
    pass.dispatchWorkgroups(count / 64);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, input.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readback.getMappedRange());
    for (let i = 0; i < count; i++) {
      const p = i * 8;
      const a = Array.from(input.subarray(p, p + 3));
      const b = Array.from(result.subarray(p, p + 3));
      const dot =
        a.reduce((sum, value, axis) => sum + value * (b[axis] ?? NaN), 0) /
        (Math.hypot(...a) * Math.hypot(...b));
      expect((Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI).toBeLessThan(0.07);
      for (const scalar of [3, 7])
        expect(
          Math.abs((result[p + scalar] ?? NaN) - (input[p + scalar] ?? NaN)),
        ).toBeLessThanOrEqual(1 / 510 + 1e-6);
      for (const color of [4, 5, 6])
        expect(Math.abs((result[p + color] ?? NaN) - (input[p + color] ?? NaN))).toBeLessThan(
          1 / 255 + 1e-6,
        );
    }
    readback.unmap();
  } finally {
    source.destroy();
    output.destroy();
    readback.destroy();
  }
});
