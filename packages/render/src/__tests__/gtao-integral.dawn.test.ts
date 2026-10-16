import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Independent midpoint quadrature of the rendering equation on a slice.
// This oracle contains neither the shader antiderivative nor a copied GTAO implementation.
function quadrature(n: number, lo: number, hi: number): number {
  const count = 16384;
  const step = (hi - lo) / count;
  let value = 0;
  for (let i = 0; i < count; i++) {
    const theta = lo + (i + 0.5) * step;
    value += Math.max(0, Math.cos(theta - n)) * Math.abs(Math.sin(theta)) * step;
  }
  return value;
}

it('production GTAO slice integral matches independent cosine-weighted numerical integration', async () => {
  const source = readFileSync('packages/shader/src/hdrp-ssao.wgsl', 'utf8');
  const integral = source.match(/fn gtaoSliceIntegral\([\s\S]*?\n\}/)?.[0];
  if (!integral) throw new Error('Production GTAO integral is missing');
  const cases = [-1.4, -0.8, -0.2, 0, 0.2, 0.8, 1.4].flatMap((n) =>
    [0, 0.2, 0.7, 1].flatMap((left) =>
      [0, 0.2, 0.7, 1].map((right) => [n, (n - Math.PI / 2) * left, (n + Math.PI / 2) * right]),
    ),
  );
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
        Math.abs((values[i] ?? NaN) - quadrature(n, lo, hi)),
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
