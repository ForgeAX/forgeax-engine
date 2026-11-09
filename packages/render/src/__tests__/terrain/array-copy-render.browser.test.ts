import { assert, expect, it } from 'vitest';
import {
  createShaderModule,
  disposeDevice,
  ensureReady,
  requestAdapter,
} from '../../../../rhi-wgpu/src/index';
import { DataTexture } from '../../device/data-texture';
import bakeCommon from '../../terrain/layer-bake-common.wgsl?raw';
import bakeFragment from '../../terrain/layer-bake-fragment.wgsl?raw';

it.each([
  'constant',
  'bake',
] as const)('preserves copied array layers before four-target %s rendering', async (kind) => {
  await ensureReady();
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const device = (
    await (await requestAdapter(undefined, canvas)).unwrap().requestDevice()
  ).unwrap();
  const make = () =>
    device
      .createTexture({
        size: [1, 1, 3],
        format: 'rgba16float',
        usage: 23,
        textureBindingViewDimension: '2d-array',
      })
      .unwrap();
  const sources = Array.from({ length: 4 }, make),
    targets = Array.from({ length: 4 }, make);
  const read = device.createBuffer({ size: 4 * 3 * 256, usage: 9 }).unwrap();
  const code = `struct Output { @location(0) a:vec4<f32>,@location(1) b:vec4<f32>,@location(2) c:vec4<f32>,@location(3) d:vec4<f32> }
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {let p=array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));return vec4<f32>(p[i],0,1);}
@fragment fn fs()->Output {return Output(vec4<f32>(0,0,1,1),vec4<f32>(0,0,1,0),vec4<f32>(1,1,0,0),vec4<f32>(0,0,1,0));}`;
  const pages = new DataTexture(device, 64 * 1024 * 1024, 'array-bake-source', 2048, () => {});
  const source = pages.capture();
  const uniform = device.createBuffer({ size: 208, usage: 72 }).unwrap();
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
        { binding: 1, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 2, visibility: 2, sampler: { type: 'filtering' } },
      ],
    })
    .unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } },
        {
          binding: 1,
          resource: {
            kind: 'textureView',
            value: source.textureView,
          },
        },
        { binding: 2, resource: { kind: 'sampler', value: sampler } },
      ],
    })
    .unwrap();
  const values = new Float32Array(52);
  values.set([0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 0]);
  for (let i = 0; i < 5; i++) values.set([-3, 1, 1, 1], 20 + i * 4);
  new Uint32Array(values.buffer).set([2, 1, 1, 0], 48);
  device.queue.writeBuffer(uniform, 0, values).unwrap();
  try {
    for (const source of sources)
      device.queue
        .writeTexture(
          { texture: source },
          new Uint16Array([1, 1, 1, 1, 1, 0, 0, 1, 0, 1, 0, 1].map((v) => (v ? 0x3c00 : 0))),
          { bytesPerRow: 8, rowsPerImage: 1 },
          [1, 1, 3],
        )
        .unwrap();
    const module = (
      await createShaderModule(device, {
        code: kind === 'bake' ? `${bakeCommon}\n${bakeFragment}` : code,
      })
    ).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device
          .createPipelineLayout({ bindGroupLayouts: kind === 'bake' ? [layout] : [] })
          .unwrap(),
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: targets.map(() => ({ format: 'rgba16float' })),
        },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    for (const [i, source] of sources.entries()) {
      const target = targets[i];
      assert(target);
      encoder.copyTextureToTexture({ texture: source }, { texture: target }, [1, 1, 3]);
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: targets.map((texture) => ({
        view: device
          .createTextureView(texture, { dimension: '2d', baseArrayLayer: 2, arrayLayerCount: 1 })
          .unwrap(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      })),
    });
    pass.setPipeline(pipeline);
    if (kind === 'bake') pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    for (const [i, texture] of targets.entries()) {
      encoder.copyTextureToBuffer(
        { texture },
        { buffer: read, offset: i * 3 * 256, bytesPerRow: 256, rowsPerImage: 1 },
        [1, 1, 3],
      );
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapping = (await read.mapAsync(1)).unwrap();
    const bytes = mapping.getMappedRange().unwrap();
    const pixels = Array.from({ length: 4 }, (_, i) =>
      Array.from({ length: 3 }, (_, layer) =>
        Array.from(
          new Uint16Array(bytes.slice((i * 3 + layer) * 256, (i * 3 + layer) * 256 + 8)),
          (bits) => bits / 0x3c00,
        ),
      ),
    );
    mapping.unmap();
    expect(canvas.getContext('webgl2')?.getError()).toBe(0);
    expect(pixels).toEqual([
      [
        [1, 1, 1, 1],
        [1, 0, 0, 1],
        [0, 0, 1, 1],
      ],
      [
        [1, 1, 1, 1],
        [1, 0, 0, 1],
        [0, 0, 1, 0],
      ],
      [
        [1, 1, 1, 1],
        [1, 0, 0, 1],
        [1, 1, 0, 0],
      ],
      [
        [1, 1, 1, 1],
        [1, 0, 0, 1],
        [0, 0, 1, 0],
      ],
    ]);
    expect(canvas.getContext('webgl2')?.getError()).toBe(0);
  } finally {
    for (const texture of [...sources, ...targets]) device.destroyTexture(texture).unwrap();
    device.destroyBuffer(read).unwrap();
    device.destroyBuffer(uniform).unwrap();
    source.release();
    pages.dispose();
    disposeDevice(device);
    canvas.remove();
  }
}, 60000);
