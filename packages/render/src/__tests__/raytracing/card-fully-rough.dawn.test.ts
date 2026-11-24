import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';
import { CONTROLLED_CARD_RECEIVER_TAG, frozenCardStatusQuery } from './card-shadow-status.fixture';

it('projects authored Card planes to the selected fully rough transport without changing emission or roughness', async () => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Real GPU adapter required');
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [],
    textures: GPUTexture[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffer = (values: Float32Array | Uint32Array, usage: number) => {
    const result = device.createBuffer({ size: values.byteLength, usage: usage | 8 });
    device.queue.writeBuffer(result, 0, values);
    buffers.push(result);
    return result;
  };
  const texture = (values: readonly number[]) => {
    const result = device.createTexture({ size: [1, 1], format: 'rgba32float', usage: 4 | 2 });
    device.queue.writeTexture({ texture: result }, Float32Array.from(values), {}, [1, 1]);
    textures.push(result);
    return result.createView();
  };
  try {
    const base = [0.2, 0.4, 0.8];
    // F0 is already mixed by the authored material evaluator. A second metallic
    // mix is a wrong implementation, as is using raw baseColor for all metals.
    const cases = [0, 0.5, 1].flatMap((metallic) =>
      [0.04, 1].map((roughness) => ({
        name: `metal-${metallic}-rough-${roughness}`,
        base,
        metallic,
        roughness,
        f0: base.map((value) => 0.04 * (1 - metallic) + value * metallic),
        validity: 1,
      })),
    );
    cases.push({
      name: 'zero-specular',
      base,
      metallic: 0,
      roughness: 0.5,
      f0: [0, 0, 0],
      validity: 1,
    });
    cases.push({
      name: 'known-black',
      base: [0, 0, 0],
      metallic: 0,
      roughness: 0.5,
      f0: [0, 0, 0],
      validity: 1,
    });
    cases.push({
      name: 'colored-dielectric',
      base,
      metallic: 0,
      roughness: 0.5,
      f0: [0.01, 0.08, 0.16],
      validity: 1,
    });
    cases.push({
      name: 'missing-material',
      base,
      metallic: 0,
      roughness: 0.5,
      f0: [0.04, 0.04, 0.04],
      validity: 0,
    });
    const card = new Float32Array(20);
    card.set([1, 0, 0, 1], 4);
    card.set([0, 0, 1, 1], 8);
    card.set([0, 1, 0, 1], 12);
    new Uint32Array(card.buffer).set([0, 1, 0, 0], 16);
    const frame = new Uint32Array(32);
    frame.set([0, 1, 1, 0], 4);
    frame.set([1, 1, 1, 0], 8);
    new Float32Array(frame.buffer).set([4, 0.25, 8, 0.25], 16);
    frame.set([36, 4, 1, 1], 28);
    const receiver = new Uint32Array(12);
    new Float32Array(receiver.buffer).set([0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0]);
    receiver.set([0, 0, 1, CONTROLLED_CARD_RECEIVER_TAG], 8);
    const output = buffer(new Float32Array(16), 128 | 4);
    const observed = buffer(new Uint32Array(4), 128);
    const depth = device.createTexture({ size: [1, 1], format: 'depth32float', usage: 16 | 4 });
    textures.push(depth);
    const module = device.createShaderModule({
      code: frozenCardStatusQuery(irradianceFieldKernelWgsl('global-sdf').cardSurface),
    });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'cardSurface' },
    });
    const common: GPUBindGroupEntry[] = [
      { binding: 5, resource: { buffer: buffer(card, 128) } },
      { binding: 6, resource: { buffer: buffer(new Float32Array(32 * 16), 64) } },
      { binding: 7, resource: { buffer: buffer(frame, 64) } },
      { binding: 8, resource: { buffer: buffer(Uint32Array.of(1, 0, 0, 0), 64) } },
      { binding: 9, resource: { buffer: output } },
      { binding: 11, resource: texture([0, 1, 0, 1]) },
      { binding: 14, resource: depth.createView() },
      { binding: 17, resource: { buffer: buffer(new Uint32Array(4), 64) } },
      { binding: 18, resource: { buffer: observed } },
      { binding: 19, resource: { buffer: buffer(receiver, 64) } },
    ];
    const readback = device.createBuffer({ size: cases.length * 64, usage: 1 | 8 });
    buffers.push(readback);
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
    for (const [index, c] of cases.entries()) {
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          ...common,
          { binding: 10, resource: texture([...c.base, c.roughness]) },
          { binding: 12, resource: texture([0.1, 0.2, 0.3, c.metallic]) },
          { binding: 13, resource: texture([...c.f0, c.validity]) },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, index * 64, 64);
    }
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const raw = readback.getMappedRange().slice(0);
    readback.unmap();
    const values = new Float32Array(raw),
      words = new Uint32Array(raw);
    const records = cases.map((c, index) => ({
      ...c,
      expected: c.base.map(
        (value, channel) => value * (1 - c.metallic) + 0.45 * (c.f0[channel] ?? 0),
      ),
      actual: Array.from(values.slice(index * 16 + 8, index * 16 + 12)),
      emission: Array.from(values.slice(index * 16 + 12, index * 16 + 16)),
      valid: words[index * 16 + 7],
    }));
    if (process.env.FORGEAX_CARD_PROXY_RESULT) {
      writeFileSync(
        process.env.FORGEAX_CARD_PROXY_RESULT,
        JSON.stringify({ adapter: adapter.info, records, errors }, null, 2),
      );
      writeFileSync(`${process.env.FORGEAX_CARD_PROXY_RESULT}.bin`, new Uint8Array(raw));
    }
    expect(errors).toEqual([]);
    for (const c of records) {
      expect(c.valid, c.name).toBe(c.validity);
      if (c.validity === 0) {
        expect(c.actual).toEqual([0, 0, 0, 0]);
        continue;
      }
      for (const channel of [0, 1, 2])
        expect(c.actual[channel], `${c.name}/${channel}`).toBeCloseTo(c.expected[channel] ?? 0, 6);
      expect(c.actual[3], c.name).toBeCloseTo(c.roughness, 6);
      for (const [channel, value] of [0.1, 0.2, 0.3, c.metallic].entries())
        expect(c.emission[channel], c.name).toBeCloseTo(value, 6);
    }
  } finally {
    for (const resource of buffers) resource.destroy();
    for (const resource of textures) resource.destroy();
    device.destroy();
  }
});
