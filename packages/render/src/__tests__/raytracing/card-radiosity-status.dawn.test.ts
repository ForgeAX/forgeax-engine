import { expect, it } from 'vitest';
import {
  cardRadiosityStatusCases,
  cardRadiosityStatusFixture,
} from './card-radiosity-status.fixture';

it('retains known-zero backfaces and black while keeping missing transport unavailable', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Card radiosity status requires an actual GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const owned: GPUBuffer[] = [];
  try {
    const allocate = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage });
      owned.push(buffer);
      return buffer;
    };
    const count = cardRadiosityStatusCases.length;
    const inputs = allocate(count * 16, 128 | 8),
      cards = allocate(count * 16, 128 | 8);
    const output = allocate(count * 32, 128 | 4),
      readback = allocate(count * 32, 1 | 8);
    device.queue.writeBuffer(
      inputs,
      0,
      Uint32Array.from(cardRadiosityStatusCases.flatMap((row) => [row.state, row.back, 0, 0])),
    );
    device.queue.writeBuffer(
      cards,
      0,
      Float32Array.from(cardRadiosityStatusCases.flatMap((row) => [...row.card])),
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: cardRadiosityStatusFixture }),
        entryPoint: 'auditCardRadiosityStatus',
      },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [inputs, cards, output].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, count * 32);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    for (const [i, row] of cardRadiosityStatusCases.entries())
      expect([...values.subarray(i * 8, i * 8 + 4)], `case ${i}`).toEqual([...row.expected]);
    for (const i of [1, 2, 3]) {
      expect(values[i * 8 + 3]).toBe(1);
      expect(values[i * 8 + 7]).toBe(0);
    }
    expect(errors).toEqual([]);
  } finally {
    for (const buffer of owned) buffer.destroy();
    device.destroy();
  }
});
