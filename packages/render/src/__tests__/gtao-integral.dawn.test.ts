import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { cosineWeightedSliceQuadrature } from './gtao-reference';

it('production GTAO slice integral matches independent cosine-weighted numerical integration', async () => {
  const source = readFileSync('packages/shader/src/hdrp-ssao.wgsl', 'utf8');
  const integral = source.match(/fn gtaoSliceIntegral\([\s\S]*?\n\}/)?.[0];
  if (!integral) throw new Error('Production GTAO integral is missing');
  const edgeCases = [
    [Math.PI, Math.PI / 2, (3 * Math.PI) / 2],
    [-Math.PI, (-3 * Math.PI) / 2, -Math.PI / 2],
    [0, 0.25, 1.2],
    [0, -1.2, -0.25],
    [Math.PI / 2 - 0.0001, 0.00001, Math.PI - 0.0002],
    [-Math.PI / 2 + 0.0001, -Math.PI + 0.0002, -0.00001],
    [2, 0.6, 1.4],
    [-2, -1.4, -0.6],
    [2.9, 2.5, 3.5],
    [-2.9, -3.5, -2.5],
    [0.7, 1.1, 1.1],
    [1.2, 0.2, 1.9],
    [-1.2, -1.9, -0.2],
    [0.4, -0.3, 0.9],
  ] as const;
  const cases = [-1.4, -0.8, -0.2, 0, 0.2, 0.8, 1.4]
    .flatMap((n) =>
      [0, 0.2, 0.7, 1].flatMap((left) =>
        [0, 0.2, 0.7, 1].map((right) => [n, (n - Math.PI / 2) * left, (n + Math.PI / 2) * right]),
      ),
    )
    .concat(edgeCases.map((value) => [...value]));
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const output = device.createBuffer({ size: cases.length * 4, usage: 0x80 | 0x04 });
  const readback = device.createBuffer({ size: cases.length * 4, usage: 0x01 | 0x08 });
  try {
    const module = device.createShaderModule({
      code: `${integral}
      @group(0) @binding(0) var<storage, read_write> output: array<f32>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let cases = array<vec3<f32>, ${cases.length}>(${cases.map((v) => `vec3<f32>(${v.join(',')})`).join(',')});
        let v = cases[id.x];
        output[id.x] = gtaoSliceIntegral(v.x, v.y, v.z);
      }`,
    });
    const pipeline = device.createComputePipeline({
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
    pass.dispatchWorkgroups(cases.length);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, cases.length * 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const values = new Float32Array(readback.getMappedRange());
    for (const [i, c] of cases.entries()) {
      const [n, lo, hi] = c as [number, number, number];
      expect(
        Math.abs((values[i] ?? NaN) - cosineWeightedSliceQuadrature(n, lo, hi)),
        `slice ${n}, ${lo}, ${hi}`,
      ).toBeLessThan(0.000002);
    }
    readback.unmap();
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
