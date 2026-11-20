import { expect, it } from 'vitest';
import { readEngineTemplates } from '../../__tests__/engine-shader-templates.dawn.fixture';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';

const SIZE = 4;
const STRIDE = 256;
const EXTINCTION = 0.00012;
const VERTICAL_CLOUD_LENGTH = 10_000;

function fixtureView(): Float32Array {
  const data = new Float32Array(VIEW_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
  data.set([0, -1, 0], 16); // world sun direction toward the receiver
  data.set([100, 100, 100], 20);
  // Reverse Z: a constant +Y ray, with z=1 mapping to world y=1 m.
  data.set([1, 0, 0, 0, 0, 0, 1, 0, 0, -10_000, 0, 0, 0, 10_001, 0, 1], 44);
  return data;
}

function nonnegativeHalf(bits: number): number {
  const exponent = (bits >>> 10) & 31;
  const mantissa = bits & 1023;
  return exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

it('reads the cooked Standard analytic cloud MRT and clips all transport at foreground depth', async () => {
  const registry = await readEngineTemplates();
  const entry = [...registry.materialShaderManifestEntries()].find(
    (value) => value.identifier === 'forgeax::cloud-analytic-view',
  );
  expect(entry?.composedWgsl).toBeTruthy();
  if (entry?.composedWgsl === undefined)
    throw new Error('Missing the cooked analytic cloud entry.');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No Dawn GPU adapter.');
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: entry.composedWgsl });
  expect(
    (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
  ).toEqual([]);
  const group0 = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });
  const group1 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
    ],
  });
  const pipeline = await device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [group0, group1] }),
    vertex: { module, entryPoint: 'vs_main' },
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba32float' }],
    },
  });
  const render = GPUTextureUsage.RENDER_ATTACHMENT;
  const sample = GPUTextureUsage.TEXTURE_BINDING;
  const read = GPUTextureUsage.COPY_SRC;
  const texture = (format: GPUTextureFormat, usage: number) =>
    device.createTexture({ format, size: [SIZE, SIZE], usage });
  const scene = texture('rgba16float', render | sample);
  const depth = texture('depth32float', render | sample);
  const out = texture('rgba16float', render);
  const lt = texture('rgba16float', render | read);
  const meters = texture('rgba32float', render | read);
  const viewUniform = device.createBuffer({
    size: VIEW_UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const cloudUniform = device.createBuffer({
    // AnalyticCloudParams includes the Mode 0 phase/full-extent tail.
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(viewUniform, 0, fixtureView() as Float32Array<ArrayBuffer>);
  device.queue.writeBuffer(
    cloudUniform,
    0,
    new Float32Array([5000, 10_000, 350_000, 200_000, 0.95, 0.95, 0.95, EXTINCTION, 0, 0, 0, 1]),
  );
  const viewBindings = device.createBindGroup({
    layout: group0,
    entries: [{ binding: 0, resource: { buffer: viewUniform } }],
  });
  const inputs = device.createBindGroup({
    layout: group1,
    entries: [
      { binding: 0, resource: scene.createView() },
      { binding: 1, resource: device.createSampler({ minFilter: 'linear' }) },
      { binding: 2, resource: { buffer: cloudUniform } },
      { binding: 3, resource: depth.createView({ aspect: 'depth-only' }) },
      { binding: 4, resource: device.createSampler() },
    ],
  });
  const readback = device.createBuffer({
    size: STRIDE * SIZE * 2,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const attachment = (target: GPUTexture) => ({
    view: target.createView(),
    loadOp: 'clear' as const,
    storeOp: 'store' as const,
  });
  const draw = async (depthValue: number, copy: boolean) => {
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [{ ...attachment(scene), clearValue: [1, 2, 3, 1] }],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: depthValue,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
    const pass = encoder.beginRenderPass({ colorAttachments: [out, lt, meters].map(attachment) });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, viewBindings);
    pass.setBindGroup(1, inputs);
    pass.draw(3);
    pass.end();
    if (copy) {
      encoder.copyTextureToBuffer({ texture: lt }, { buffer: readback, bytesPerRow: STRIDE }, [
        SIZE,
        SIZE,
      ]);
      encoder.copyTextureToBuffer(
        { texture: meters },
        { buffer: readback, offset: STRIDE * SIZE, bytesPerRow: STRIDE },
        [SIZE, SIZE],
      );
    }
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
  };
  const measure = async () => {
    await readback.mapAsync(GPUMapMode.READ);
    const raw = new DataView(readback.getMappedRange());
    const offset = STRIDE * SIZE;
    const measured = {
      radiance: nonnegativeHalf(raw.getUint16(0, true)),
      t: nonnegativeHalf(raw.getUint16(6, true)),
      entry: raw.getFloat32(offset, true),
      exit: raw.getFloat32(offset + 4, true),
      scene: raw.getFloat32(offset + 8, true),
    };
    readback.unmap();
    return measured;
  };
  try {
    for (let frame = 0; frame < 60; frame += 1) await draw(0, frame === 59);
    const clear = await measure();
    expect(clear.radiance).toBeGreaterThan(0);
    expect(Math.abs(clear.t - Math.exp(-EXTINCTION * VERTICAL_CLOUD_LENGTH))).toBeLessThan(0.002);
    expect(clear.entry).toBeCloseTo(5000, 1);
    expect(clear.exit).toBeCloseTo(15000, 1);
    expect(clear.scene).toBe(65504000);
    await draw(1, true);
    const blocked = await measure();
    expect(blocked.radiance).toBe(0);
    expect(blocked.t).toBe(1);
    expect(blocked.scene).toBeLessThan(2);
    expect(blocked.entry).toBe(65504000);
  } finally {
    readback.destroy();
    viewUniform.destroy();
    cloudUniform.destroy();
    for (const target of [scene, depth, out, lt, meters]) target.destroy();
    device.destroy();
  }
}, 180_000);
