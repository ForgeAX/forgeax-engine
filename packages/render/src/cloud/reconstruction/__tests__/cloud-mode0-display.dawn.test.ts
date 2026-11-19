import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { VIEW_UNIFORM_BYTES } from '../../../record/view-ubo';

it('renders Mode 0 transport, rejecting sky history in front of opaque silhouettes', async () => {
  const engine = await loadEngineShaderEntries();
  const compiled = await compileShader(engine.cloudMode0Compose.source, {
    id: engine.cloudMode0Compose.id,
    imports: engine.imports,
    defines: { ATMOSPHERE_AVAILABLE: false },
  });
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  if (process.env.FORGEAX_CLOUD_REQUIRE_HARDWARE === '1')
    expect(adapter.info.isFallbackAdapter).toBe(false);
  const device = await adapter.requestDevice();
  const textures: GPUTexture[] = [];
  const buffers: GPUBuffer[] = [];
  const texture = (format: GPUTextureFormat, usage: number) => {
    const value = device.createTexture({ format, size: [1, 1], usage });
    textures.push(value);
    return value;
  };
  const buffer = (size: number, usage: number) => {
    const value = device.createBuffer({ size, usage });
    buffers.push(value);
    return value;
  };
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    expect(
      (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
    ).toEqual([]);
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
    });
    const sourceUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const background = texture('rgba32float', sourceUsage),
      far = texture('rgba32float', sourceUsage),
      near = texture('rgba32float', sourceUsage),
      meters = texture('rgba32float', sourceUsage);
    const depth = texture(
      'depth32float',
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    );
    const output = texture(
      'rgba32float',
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    );
    const viewBuffer = buffer(VIEW_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      params = buffer(128, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      readback = buffer(256, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const view = new Float32Array(VIEW_UNIFORM_BYTES / 4);
    view.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
    view.set([1, 0, 0, 0, 0, 0, 1, 0, 0, -10000, 0, 0, 0, 10001, 0, 1], 44);
    device.queue.writeBuffer(viewBuffer, 0, view);
    const upload = (target: GPUTexture, values: number[]) =>
      device.queue.writeTexture(
        { texture: target },
        new Float32Array(values),
        { bytesPerRow: 16 },
        [1, 1],
      );
    upload(background, [0.25, 0.125, 0.0625, 1]);
    const group0 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: viewBuffer } }],
    });
    const group1 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: background.createView() },
        { binding: 2, resource: { buffer: params } },
        { binding: 3, resource: depth.createView() },
        { binding: 5, resource: far.createView() },
        { binding: 6, resource: near.createView() },
        { binding: 7, resource: meters.createView() },
      ],
    });
    const observations = [];
    const cases = [
      ...[0.5, 0.98, 1].flatMap((transmittance) =>
        [3, 4].map((mode) => ({ mode, transmittance, deviceDepth: 0 })),
      ),
      // Camera motion can leave sky radiance in the reconstructed near lane
      // even though the depth metadata comes from a mixed silhouette tile.
      ...[0, 3, 4].map((mode) => ({ mode, transmittance: 0.5, deviceDepth: 1 })),
      // A distant opaque surface still receives clouds that lie in front of it.
      { mode: 0, transmittance: 0.5, deviceDepth: 0.125 },
    ];
    for (const { mode, transmittance, deviceDepth } of cases) {
      upload(far, [0.5, 0.25, 0.125, transmittance]);
      upload(near, [0.5, 0.25, 0.125, transmittance]);
      const surfaceMeters = 10001 - 10000 * deviceDepth;
      upload(meters, [9000, surfaceMeters, surfaceMeters, 65504000]);
      const values = new Float32Array(32);
      values.set([1, 1], 18);
      values[23] = 5000;
      values[24] = mode;
      values.set([5000, 10000, 350000, 50000], 28);
      device.queue.writeBuffer(params, 0, values);
      const encoder = device.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: deviceDepth,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        })
        .end();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: output.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
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
      const actual = Array.from(new Float32Array(readback.getMappedRange(), 0, 4));
      readback.unmap();
      const blocked = deviceDepth === 1;
      const visibleTransmittance = blocked ? 1 : transmittance;
      const expected =
        mode === 0
          ? blocked
            ? [0.25, 0.125, 0.0625]
            : [0.625, 0.3125, 0.15625]
          : Array(3).fill(
              mode === 3 ? visibleTransmittance : Number(1 - visibleTransmittance > 0.05),
            );
      if (blocked && mode === 0) expect(actual).toEqual([...expected, 1]);
      else for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
      expect(actual[3]).toBe(1);
      observations.push({ mode, transmittance, deviceDepth, actual });
    }
    const evidence = process.env.FORGEAX_CLOUD_DISPLAY_EVIDENCE;
    if (evidence)
      await writeFile(
        evidence,
        JSON.stringify(
          {
            scope:
              'Actual Mode0 fragment, ATMOSPHERE_AVAILABLE=false bounded display fixture; not full Demo/AP evidence',
            adapter: {
              vendor: adapter.info.vendor,
              device: adapter.info.device,
              isFallbackAdapter: adapter.info.isFallbackAdapter,
            },
            observations,
          },
          null,
          2,
        ),
      );
  } finally {
    for (const value of textures) value.destroy();
    for (const value of buffers) value.destroy();
    device.destroy();
  }
});
