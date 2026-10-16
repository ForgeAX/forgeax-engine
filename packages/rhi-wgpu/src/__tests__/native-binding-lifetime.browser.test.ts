import { ensureReady } from '@forgeax/engine-wgpu-wasm';
import { expect, it } from 'vitest';
import { disposeDevice, makeRhiDevice } from '../device';
import { driveNativeCompletion } from '../internal/native-completion';

async function fixture() {
  const canvas = document.createElement('canvas');
  const wasm = await ensureReady();
  const memory = (await wasm.default()).memory;
  const instance = await wasm.RhiWgpuInstance.create();
  const adapter = await instance.requestAdapterWithCanvas(canvas);
  if (!(adapter instanceof wasm.RhiWgpuAdapter)) throw new Error(String(adapter));
  const device = await adapter.requestDevice({});
  const owner = makeRhiDevice(device as unknown as Parameters<typeof makeRhiDevice>[0]).device;
  const queue = device.queue;
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('Actual WebGL2 is required');
  const source = device.createTexture({
    size: { width: 4, height: 4, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: 0x02 | 0x04,
  });
  const uniform = device.createBuffer({ size: 16, usage: 0x08 | 0x40 });
  const sampler = device.createSampler({});
  const layoutDescriptor = {
    entries: [
      { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
      { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
      { binding: 2, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
    ],
  };
  const layout = device.createBindGroupLayout(layoutDescriptor);
  const view = source.createView({});
  const entries = (textureView = view) => [
    { binding: 0, resource: { buffer: uniform } },
    { binding: 1, resource: sampler },
    { binding: 2, resource: textureView },
  ];
  return {
    canvas,
    device,
    queue,
    source,
    uniform,
    sampler,
    layout,
    layoutDescriptor,
    view,
    entries,
    memory,
    gl,
    complete: () => queue.onSubmittedWorkDone(driveNativeCompletion),
    dispose() {
      view.free();
      sampler.free();
      layout.free();
      uniform.destroy();
      uniform.free();
      source.destroy();
      source.free();
      queue.free();
      disposeDevice(owner);
      adapter.free();
      instance.free();
    },
  };
}

it.each([
  'views',
  'groups',
  'view-labels',
  'parse-failures',
  'samplers',
  'layouts',
  'sampler-labels',
  'layout-labels',
  'group-labels',
] as const)('bounds native %s retention across identical completed 60-frame batches', async (mode) => {
  const f = await fixture();
  const heapBytes: number[] = [];
  const label = 'borrowed-view-label-'.repeat(256);
  try {
    for (let batch = 0; batch < 3; batch += 1) {
      for (let frame = 0; frame < 60; frame += 1) {
        for (let item = 0; item < 64; item += 1) {
          if (mode === 'samplers' || mode === 'sampler-labels') {
            f.device.createSampler(mode === 'sampler-labels' ? { label } : {}).free();
          } else if (mode === 'layouts' || mode === 'layout-labels') {
            f.device
              .createBindGroupLayout({
                label: mode === 'layout-labels' ? label : undefined,
                entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform' } }],
              })
              .free();
          } else if (mode === 'groups' || mode === 'group-labels') {
            f.device
              .createBindGroup({
                layout: f.layout,
                label: mode === 'group-labels' ? label : undefined,
                entries: f.entries(),
              })
              .free();
          } else if (mode === 'parse-failures') {
            expect(() =>
              f.device.createBindGroup({
                layout: f.layout,
                entries: [...f.entries().slice(0, 2), { binding: 2, resource: {} }],
              }),
            ).toThrow();
            expect(() => f.source.createView({ label, dimension: 'invalid' })).toThrow();
          } else {
            const descriptor = mode === 'view-labels' ? { label } : {};
            const view =
              item % 2 === 0
                ? f.source.createView(descriptor)
                : f.device.createTextureView(f.source, descriptor);
            view.free();
          }
        }
        const encoder = f.device.createCommandEncoder({});
        f.queue.submit([encoder.finish()]);
        encoder.free();
        await f.complete();
      }
      heapBytes.push(f.memory.buffer.byteLength);
    }
    // biome-ignore lint/suspicious/noConsole: measured bounded allocator regression evidence.
    console.info(
      JSON.stringify({ kind: 'native-binding-retention', mode, completed: 180, heapBytes }),
    );
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR);
    const warmup = heapBytes[0];
    const last = heapBytes[2];
    if (warmup === undefined || last === undefined) throw new Error('Missing batch samples');
    expect(last - warmup).toBeLessThanOrEqual(4 * 65536);
  } finally {
    f.dispose();
  }
});

it('keeps bind groups and pipeline layouts usable after source view, sampler and layout wrappers are released', async () => {
  const f = await fixture();
  const view = f.device.createTextureView(f.source, {});
  const sampler = f.device.createSampler({});
  const layout = f.device.createBindGroupLayout(f.layoutDescriptor);
  const entries = f
    .entries(view)
    .map((entry) => (entry.binding === 1 ? { binding: 1, resource: sampler } : entry));
  const first = f.device.createBindGroup({ layout, entries });
  const second = f.device.createBindGroup({ layout, entries });
  const pipelineLayout = f.device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const tokens = {
    view: view.forgeaxToken,
    sampler: sampler.forgeaxToken,
    layout: layout.forgeaxToken,
  };
  view.free();
  sampler.free();
  layout.free();
  const shader = f.device.createShaderModule({
    code: `
@group(0) @binding(0) var<uniform> tint: vec4f;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var image: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs() -> @location(0) vec4f {
  return tint * textureSampleLevel(image, imageSampler, vec2f(0.5), 0.0);
}`,
  });
  const pipeline = f.device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module: shader, entryPoint: 'vs', buffers: [] },
    fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  const target = f.device.createTexture({
    size: { width: 4, height: 4, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: 0x10 | 0x01,
  });
  const targetView = target.createView({});
  const readback = f.device.createBuffer({ size: 1024, usage: 0x01 | 0x08 });
  try {
    for (const kind of ['textureView', 'sampler'] as const) {
      const retired = {
        forgeaxResourceKind: kind,
        forgeaxToken: kind === 'textureView' ? tokens.view : tokens.sampler,
      };
      const entries = f
        .entries()
        .map((entry) =>
          entry.binding === (kind === 'textureView' ? 2 : 1)
            ? { binding: entry.binding, resource: retired }
            : entry,
        );
      expect(() => f.device.createBindGroup({ layout: f.layout, entries })).toThrow(
        'not in registry',
      );
    }
    expect(() =>
      f.device.createBindGroup({ layout: { forgeaxToken: tokens.layout }, entries: f.entries() }),
    ).toThrow('not in registry');
    const data = new Uint8Array(4 * 4 * 4);
    for (let pixel = 0; pixel < 16; pixel += 1) data.set([32, 128, 224, 255], pixel * 4);
    f.queue.writeTexture(f.source, 0, 0, 0, 0, 0, data, 0n, 16, 4, 4, 4, 1);
    f.queue.writeBuffer(f.uniform, 0n, new Uint8Array(new Float32Array([1, 1, 1, 1]).buffer));
    for (const group of [first, second]) {
      const encoder = f.device.createCommandEncoder({});
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group, []);
      pass.draw(3, 1, 0, 0);
      pass.end();
      pass.free();
      encoder.copyTextureToBuffer(target, 0, 0, 0, 0, 0, readback, 0n, 256, 4, 4, 4, 1);
      f.queue.submit([encoder.finish()]);
      encoder.free();
      await f.complete();
      await readback.mapAsync(1);
      try {
        expect([...new Uint8Array(readback.getMappedRange()).slice(0, 4)]).toEqual([
          32, 128, 224, 255,
        ]);
      } finally {
        readback.unmap();
      }
    }
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR);
  } finally {
    readback.destroy();
    readback.free();
    targetView.free();
    target.destroy();
    target.free();
    first.free();
    second.free();
    pipeline.free();
    pipelineLayout.free();
    shader.free();
    f.dispose();
  }
});

it('releases native validation failures without poisoning the next create or submit', async () => {
  const f = await fixture();
  try {
    expect(() => f.device.createBindGroup({ layout: f.layout, entries: [] })).toThrow();
    expect(() => f.source.createView({ baseMipLevel: 1 })).toThrow();
    expect(() => f.device.createSampler({ maxAnisotropy: 0 })).toThrow();
    expect(() =>
      f.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
          { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
        ],
      }),
    ).toThrow();
    f.device.createBindGroup({ layout: f.layout, entries: f.entries() }).free();
    f.source.createView({}).free();
    f.device.createSampler({}).free();
    f.device.createBindGroupLayout(f.layoutDescriptor).free();
    f.queue.submit([]);
    await f.complete();
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR);
  } finally {
    f.dispose();
  }
});
