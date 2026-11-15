import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { VIEW_UNIFORM_BYTES } from '../../../record/view-ubo';

it('reads actual reference probe evaluations with independent fixed two-step budget', async () => {
  const engine = await loadEngineShaderEntries();
  const entry = engine.cloudAtmosphere.find(
    (entry) =>
      entry.reservedIdentifier?.startsWith('forgeax::cloud-sampled-view-') &&
      entry.id.endsWith('detail=false'),
  );
  if (!entry) throw new Error('Missing sampled source');
  const compiled = await compileShader(entry.source, {
    id: entry.id,
    imports: engine.imports,
  });
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  if (process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE === '1')
    expect(adapter.info.isFallbackAdapter).toBe(false);
  const device = await adapter.requestDevice();
  const textures: GPUTexture[] = [];
  const buffers: GPUBuffer[] = [];
  const tex = (
    format: GPUTextureFormat,
    size: number,
    dimension: GPUTextureDimension = '2d',
    extra = 0,
  ) => {
    const value = device.createTexture({
      format,
      size: [size, size, 1],
      dimension,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | extra,
    });
    textures.push(value);
    return value;
  };
  const buf = (size: number, usage: number) => {
    const value = device.createBuffer({ size, usage });
    buffers.push(value);
    return value;
  };
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_probe',
        targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba32float' }],
      },
    });
    const color = tex('rgba8unorm', 4),
      white = tex('rgba8unorm', 1),
      zero = tex('rgba8unorm', 1),
      body = tex('rgba8unorm', 1, '3d'),
      bsm = tex('rgba32float', 1);
    device.queue.writeTexture({ texture: color }, new Uint8Array(64), { bytesPerRow: 16 }, [4, 4]);
    device.queue.writeTexture(
      { texture: zero },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    for (const texture of [white, body])
      device.queue.writeTexture(
        { texture },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        [1, 1, 1],
      );
    device.queue.writeTexture(
      { texture: bsm },
      new Float32Array([0, 0, 0, 0]),
      { bytesPerRow: 16 },
      [1, 1],
    );
    const depth = device.createTexture({
      format: 'depth32float',
      size: [4, 4],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    textures.push(depth);
    const outputs = [
      tex('rgba16float', 1, '2d', GPUTextureUsage.RENDER_ATTACHMENT),
      tex('rgba16float', 1, '2d', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC),
      tex('rgba32float', 1, '2d', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC),
    ] as const;
    const view = buf(VIEW_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      params = buf(304, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      read = buf(512, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const v = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    v.set([0, -1, 0], 16);
    v.set([0, 0, 0, 0, 0, 0, 0, 0, 0, -10000, 0, 0, 0, 10001, 0, 1], 44);
    device.queue.writeBuffer(view, 0, v);
    const seed = device.createCommandEncoder();
    seed
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      })
      .end();
    device.queue.submit([seed.finish()]);
    const group0 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: view } }],
    });
    const group1 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: color.createView() },
        {
          binding: 1,
          resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
        },
        { binding: 2, resource: { buffer: params } },
        { binding: 3, resource: depth.createView() },
        { binding: 5, resource: zero.createView() },
        { binding: 6, resource: zero.createView() },
        { binding: 7, resource: white.createView() },
        { binding: 8, resource: body.createView() },
        { binding: 9, resource: bsm.createView() },
        { binding: 10, resource: white.createView() },
        { binding: 11, resource: white.createView() },
      ],
    });
    const results = [];
    for (const skip of [false, true]) {
      const values = new Float32Array(76);
      values.set([5000, 10000, 350000, 200000]);
      values.set([256000, -2, 0, Number(skip)], 4);
      values.set([1, 1, 1, 1], 8);
      values.set([1, 1, 1, 1], 12);
      values.set([2, 2, 2, 0], 20);
      values.set([2, 2, 0, 0], 24);
      values.set([0.15, -0.2, 0, 0], 28);
      values.set([0, 0, 0, 0], 32);
      values.set([0, 1, 15000, 0], 36);
      device.queue.writeBuffer(params, 0, values);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: outputs.map((texture) => ({
          view: texture.createView(),
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
          clearValue: [0, 0, 0, 0],
        })),
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group0);
      pass.setBindGroup(1, group1);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: outputs[1] },
        { buffer: read, bytesPerRow: 256 },
        [1, 1],
      );
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const bits = Array.from(new Uint16Array(read.getMappedRange(), 0, 4));
      read.unmap();
      const actual = bits.map((value) => {
        const e = (value >>> 10) & 31;
        const m = value & 1023;
        return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
      });
      expect(actual.slice(0, 3)).toEqual([2, 2, skip ? 0 : 2]);
      results.push({ skip, actual });
    }
    const evidence = process.env.FORGEAX_CLOUD_PROBE_EVIDENCE;
    if (evidence)
      await writeFile(
        evidence,
        JSON.stringify(
          {
            scope:
              'Separate1x1referenceprobe atrequestedfullpixel2,2, sameproductiontrace; notnormalquarterpixel',
            adapter: {
              vendor: adapter.info.vendor,
              device: adapter.info.device,
              isFallbackAdapter: adapter.info.isFallbackAdapter,
            },
            independentExpectedBudget: 2,
            results,
          },
          null,
          2,
        ),
      );
  } finally {
    for (const t of textures) t.destroy();
    for (const b of buffers) b.destroy();
    device.destroy();
  }
});
