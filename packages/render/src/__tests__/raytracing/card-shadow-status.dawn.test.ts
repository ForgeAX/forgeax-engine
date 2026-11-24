import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { rebuildCardOwnerIndex } from '../../raytracing/card-owner-index';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';
import { CONTROLLED_CARD_RECEIVER_TAG, frozenCardStatusQuery } from './card-shadow-status.fixture';

it('does not illuminate a Card when its shadow query exhausts steps or lacks a field', async () => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Real GPU adapter required');
  const device = await adapter.requestDevice();
  const owned: GPUBuffer[] = [],
    textures: GPUTexture[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffer = (data: Uint8Array, usage: number) => {
    const b = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
    device.queue.writeBuffer(b, 0, data);
    owned.push(b);
    return b;
  };
  const bytes = (data: Float32Array | Uint32Array) => new Uint8Array(data.buffer);
  const texture = (value: readonly number[]) => {
    const t = device.createTexture({ size: [1, 1], format: 'rgba32float', usage: 4 | 2 });
    device.queue.writeTexture({ texture: t }, Float32Array.from(value), {}, [1, 1]);
    textures.push(t);
    return t.createView();
  };
  try {
    const card = new Float32Array(20);
    card.set([1, 0, 0, 1], 4);
    card.set([0, 0, 1, 1], 8);
    card.set([0, 1, 0, 1], 12);
    new Uint32Array(card.buffer).set([0, 1, 0, 0], 16);
    rebuildCardOwnerIndex(new Uint8Array(card.buffer, card.byteOffset, card.byteLength), 1);
    const light = new Float32Array(32 * 16);
    light[3] = 1;
    light.set([1, 1, 1, 1], 4);
    light.set([0, -1, 0, 10], 8);
    const frame = new Uint32Array(32);
    frame.set([0, 1, 1, 1], 4);
    frame.set([1, 1, 1, 0], 8);
    new Float32Array(frame.buffer).set([4, 0.25, 8, 0.25], 16);
    frame.set([36, 4, 1, 1], 28);
    const receiver = new Uint32Array(12);
    new Float32Array(receiver.buffer).set([0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0]);
    receiver.set([0, 0, 1, CONTROLLED_CARD_RECEIVER_TAG], 8);
    const output = buffer(new Uint8Array(64), 128 | 4);
    const depthTexture = device.createTexture({
      size: [1, 1],
      format: 'depth32float',
      usage: 16 | 4,
    });
    textures.push(depthTexture);
    // The frozen query consumes no field. Bind only the real entry's remaining
    // resources; auto layout removes unused query buffers after this boundary.
    const entries: GPUBindGroupEntry[] = [
      { binding: 5, resource: { buffer: buffer(bytes(card), 128) } },
      { binding: 7, resource: { buffer: buffer(bytes(frame), 64) } },
      { binding: 8, resource: { buffer: buffer(bytes(Uint32Array.of(1, 0, 0, 0)), 64) } },
      { binding: 9, resource: { buffer: output } },
      { binding: 10, resource: texture([1, 1, 1, 1]) },
      { binding: 11, resource: texture([0, 1, 0, 1]) },
      { binding: 12, resource: texture([0, 0, 0, 0]) },
      { binding: 13, resource: texture([0, 0, 0, 1]) },
      { binding: 14, resource: depthTexture.createView() },
      { binding: 19, resource: { buffer: buffer(bytes(receiver), 64) } },
    ];
    const module = device.createShaderModule({
      code: frozenCardStatusQuery(irradianceFieldKernelWgsl('global-sdf').cardSurface),
    });
    const messages = (await module.getCompilationInfo()).messages
      .filter((message) => message.type === 'error')
      .map((message) => message.message);
    if (messages.length) throw new Error(messages.join('\n'));
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'cardSurface' },
    });
    const cases = [
      { name: 'miss', status: 0, expected: 1 },
      { name: 'hit', status: 1, expected: 0 },
      { name: 'negative-start', status: 2, expected: 0 },
      { name: 'step-budget', status: 3, expected: 0 },
      { name: 'missing-field', status: 4, expected: 0 },
      { name: 'unproven-outside-region', status: 5, expected: 0 },
      { name: 'invalid-status', status: 99, expected: 0 },
      { name: 'zero-energy-light-step-budget', status: 3, expected: 0, zeroRadiance: true },
    ];
    const readback = device.createBuffer({ size: cases.length * 80, usage: 1 | 8 });
    owned.push(readback);
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depthTexture.createView(),
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
    for (const [index, c] of cases.entries()) {
      const observed = buffer(new Uint8Array(16), 128 | 4);
      const caseLight = light.slice();
      if ('zeroRadiance' in c) caseLight.fill(0, 4, 7);
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          ...entries,
          { binding: 6, resource: { buffer: buffer(bytes(caseLight), 64) } },
          {
            binding: 17,
            resource: { buffer: buffer(bytes(Uint32Array.of(c.status, 0, 0, 0)), 64) },
          },
          { binding: 18, resource: { buffer: observed } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, index * 80, 64);
      encoder.copyBufferToBuffer(observed, 0, readback, index * 80 + 64, 16);
    }
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const result = new Uint32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    const records = cases.map((c, i) => ({
      ...c,
      actual: result[i * 20 + 3],
      valid: result[i * 20 + 7],
      queryMarker: Array.from(result.slice(i * 20 + 16, i * 20 + 20)),
    }));
    if (process.env.FORGEAX_GI_SHADOW_STATUS_RESULT)
      writeFileSync(
        process.env.FORGEAX_GI_SHADOW_STATUS_RESULT,
        JSON.stringify(
          {
            records,
            errors,
            scope:
              'Synthetic canonical receiver and frozen World status consumer only; no physical shadow qualification.',
          },
          null,
          2,
        ),
      );
    expect(errors).toEqual([]);
    for (const c of records) {
      expect(c.queryMarker, c.name).toEqual(
        'zeroRadiance' in c ? [0, 0, 0, 0] : [c.status, 1, 1, 1],
      );
      expect(c.valid, c.name).toBe(
        !('zeroRadiance' in c) &&
          (c.status === 3 || c.status === 4 || c.status === 5 || c.status === 99)
          ? 0
          : 1,
      );
      expect(c.actual, c.name).toBe(c.expected);
    }
  } finally {
    for (const b of owned) b.destroy();
    for (const t of textures) t.destroy();
    device.destroy();
  }
});
