import { readFile } from 'node:fs/promises';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';
import { VIEW_ABI } from '../engine-inputs/view-abi';

it.each([
  true,
  false,
])('projects the particle stream through shared shadow views: storage=%s', async (storage) => {
  const engine = await loadEngineShaderEntries();
  const source = await readFile(
    new URL('../../../vfx-render/src/shaders/mesh-shadow.wgsl', import.meta.url),
    'utf8',
  );
  const compiled = await compileShader(source, {
    id: 'particle-shadow',
    imports: engine.imports,
    defines: { STORAGE_BUFFER_AVAILABLE: storage },
  });
  if (!compiled.ok) throw compiled.error;
  expect(compiled.value.wgsl).not.toMatch(/@group\([23]\)/);
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('No Dawn adapter');
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [];
  const makeBuffer = (data: Float32Array, usage: number) => {
    const result = device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(result, 0, data);
    buffers.push(result);
    return result;
  };
  const depth = device.createTexture({
    size: [32, 32],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 32 * 256,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  buffers.push(readback);
  try {
    device.pushErrorScope('validation');
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: compiled.value.wgsl }),
        entryPoint: 'vs_main',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          {
            arrayStride: 72,
            stepMode: 'instance',
            attributes: [4, 5, 6, 7].map((shaderLocation, index) => ({
              shaderLocation,
              offset: index * 12,
              format: 'float32x3',
            })),
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const geometry = makeBuffer(
      new Float32Array([-0.8, -0.8, 0, 0.8, -0.8, 0, 0, 0.8, 0]),
      GPUBufferUsage.VERTEX,
    );
    const instance = new Float32Array(18);
    instance.set([0, 0, 0.25, 0.5, 0, 0, 0, 0.5, 0, 0, 0, 1]);
    const instances = makeBuffer(instance, GPUBufferUsage.VERTEX);
    const view = new Float32Array(VIEW_ABI.byteLength / 4);
    // The existing View ABI keeps A separate from B/C/D around inverseViewProj.
    for (const [index, offset] of [112, 240, 304, 368].entries()) {
      view.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, (index + 1) * 0.2, 0, 0, 0, 0, 1], offset / 4);
    }
    const viewBuffer = makeBuffer(view, GPUBufferUsage.UNIFORM);
    const caster = new Float32Array(20);
    caster.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.1, 1], 4);
    const casterBuffer = makeBuffer(caster, GPUBufferUsage.UNIFORM);
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: viewBuffer } },
        { binding: 7, resource: { buffer: casterBuffer } },
      ],
    });
    for (const [index, expected] of [0.05, 0.1, 0.15, 0.2, 0.35].entries()) {
      const words = new Uint32Array(caster.buffer);
      words[0] = index % 4;
      words[1] = index === 4 ? 1 : 0;
      device.queue.writeBuffer(casterBuffer, 0, caster);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.setVertexBuffer(0, geometry);
      pass.setVertexBuffer(1, instances);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: depth, aspect: 'depth-only' },
        { buffer: readback, bytesPerRow: 256 },
        [32, 32],
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = new Float32Array(readback.getMappedRange())[16 * 64 + 16];
      readback.unmap();
      expect((await device.popErrorScope())?.message).toBeUndefined();
      device.pushErrorScope('validation');
      expect(actual).toBeCloseTo(expected, 5);
    }
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    for (const buffer of buffers) buffer.destroy();
    depth.destroy();
    device.destroy();
  }
}, 60_000);
