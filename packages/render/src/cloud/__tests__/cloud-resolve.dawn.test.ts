/// <reference types="@webgpu/types" />
import { CLOUD_RESOLVE_FULLSCREEN_WGSL } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';

it('preserves scene coverage while independently compositing cloud radiance and transmittance', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const resources: Array<GPUBuffer | GPUTexture> = [];
  const texture = (format: GPUTextureFormat, usage: number) => {
    const t = device.createTexture({ size: [1, 1], format, usage });
    resources.push(t);
    return t;
  };
  const buffer = (size: number, usage: number) => {
    const b = device.createBuffer({ size, usage });
    resources.push(b);
    return b;
  };
  const source = texture('rgba16float', 6),
    radiance = texture('rgba16float', 6),
    transmission = texture('rgba16float', 6),
    cloudDepth = texture('rgba16float', 6);
  const depth = texture('depth32float', 20),
    output = texture('rgba16float', 17);
  const view = buffer(1280, 72),
    parameters = buffer(176, 72),
    readback = buffer(256, 9);
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const half = (v: number) => (v === 0 ? 0 : v === 1 ? 0x3c00 : v === 0.5 ? 0x3800 : 0x3400);
  const fill = (t: GPUTexture, v: number[]) =>
    device.queue.writeTexture(
      { texture: t },
      new Uint16Array(v.map(half)),
      { bytesPerRow: 8 },
      [1, 1],
    );
  fill(radiance, [0.25, 0.25, 0.25, 1]);
  fill(cloudDepth, [0, 0, 0.25, 1]);
  const v = new Float32Array(320);
  for (const offset of [0, 44, 252]) for (let i = 0; i < 4; i++) v[offset + i * 5] = 1;
  device.queue.writeBuffer(view, 0, v);
  device.queue.writeBuffer(parameters, 0, new Float32Array(44));
  try {
    const module = device.createShaderModule({ code: CLOUD_RESOLVE_FULLSCREEN_WGSL });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
    });
    const group0 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: view } }],
    });
    const group1 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: parameters } },
        { binding: 3, resource: depth.createView() },
        ...[radiance, transmission, cloudDepth, radiance, transmission, cloudDepth].map((t, i) => ({
          binding: i + 5,
          resource: t.createView(),
        })),
      ],
    });
    for (const opacity of [0.5, 1])
      for (const t of [0, 0.5, 1]) {
        fill(source, [0.5, 0.5, 0.5, opacity]);
        fill(transmission, [t, t, t, 1]);
        const encoder = device.createCommandEncoder();
        const clear = encoder.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        });
        clear.end();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group0);
        pass.setBindGroup(1, group1);
        pass.draw(3);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: output },
          { buffer: readback, bytesPerRow: 256 },
          [1, 1],
        );
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const raw = new Uint16Array(readback.getMappedRange());
        expect(raw[3]).toBe(half(opacity));
        const expected = 0.5 * t + 0.25;
        expect(raw[0]).toBe(expected === 0.75 ? 0x3a00 : half(expected));
        readback.unmap();
      }
  } finally {
    for (const r of resources) r.destroy();
    device.destroy();
  }
});
