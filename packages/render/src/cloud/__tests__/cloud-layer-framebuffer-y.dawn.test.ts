import { describe, expect, it } from 'vitest';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import {
  CLOUD_HISTORY_FULLSCREEN_WGSL,
  CLOUD_VIEW_FULLSCREEN_WGSL,
  CLOUD_VIEW_PARAMS_BYTES,
} from '../feature';

const WIDTH = 4;
const HEIGHT = 4;
const TEXTURE_BINDING = 0x04;
const RENDER_ATTACHMENT = 0x10;
const COPY_SRC = 0x01;
const COPY_DST = 0x02;
const MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const STORAGE = 0x0080;
const UNIFORM = 0x0040;
const MAP_MODE_READ = 0x0001;

interface Readback {
  readonly rows: readonly number[];
  readonly center: number;
}

function identity(target: Float32Array, offset: number): void {
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 15] = 1;
}

function createSource(device: GPUDevice): GPUTexture {
  const texture = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'rgba8unorm',
    usage: TEXTURE_BINDING | COPY_DST,
  });
  const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      bytes[offset] = 20 + y * 60;
      bytes[offset + 1] = 7 + x * 31;
      bytes[offset + 2] = 240 - y * 40;
      bytes[offset + 3] = 255;
    }
  }
  device.queue.writeTexture(
    { texture },
    bytes,
    { bytesPerRow: WIDTH * 4 },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  return texture;
}

function createDepth(device: GPUDevice): GPUTexture {
  return device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'depth32float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  });
}

function createViewUniforms(): Float32Array {
  const data = new Float32Array(VIEW_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
  identity(data, 0);
  identity(data, 44);
  data[16] = 0;
  data[17] = -1;
  data[18] = 0;
  data[20] = 1;
  data[21] = 1;
  data[22] = 1;
  data[24] = 0;
  data[25] = 0;
  data[26] = 0;
  return data;
}

function createCloudUniforms(density: number): Float32Array {
  const data = new Float32Array(24);
  data[0] = -1;
  data[1] = 2;
  data[2] = 1;
  data[3] = density;
  data[4] = 1;
  data[5] = 0;
  data[6] = 10;
  data[7] = 7;
  data[8] = 0;
  data[9] = 0;
  data[10] = 0;
  data[12] = 0;
  data[13] = -1;
  data[14] = 0;
  data[16] = 1;
  data[17] = 1;
  data[18] = 1;
  const integers = new Uint32Array(data.buffer);
  integers[20] = 4;
  integers[21] = 8;
  integers[22] = 8;
  return data;
}

async function render(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  depthValue: number,
  density: number,
): Promise<Readback> {
  const source = createSource(device);
  const depth = createDepth(device);
  const output = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'rgba8unorm',
    usage: RENDER_ATTACHMENT | COPY_SRC,
  });
  const viewBuffer = device.createBuffer({
    size: VIEW_UNIFORM_BYTES,
    usage: UNIFORM | BUFFER_COPY_DST,
  });
  const cloudBuffer = device.createBuffer({
    size: CLOUD_VIEW_PARAMS_BYTES,
    usage: UNIFORM | BUFFER_COPY_DST,
  });
  // The production cache contains three R8 formation planes (weather, body,
  // erosion), packed into 48 u32 lanes for the 4^3 fixture. Keep the Dawn
  // fixture on the same storage extent so the density shader never reads
  // beyond the test resource when the cloud is enabled.
  const densityBuffer = device.createBuffer({ size: 192, usage: STORAGE | BUFFER_COPY_DST });
  const previousRadiance = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'rgba16float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  });
  const previousTransmittance = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'rgba16float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  });
  const previousDepth = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'rgba16float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  });
  const readback = device.createBuffer({
    size: 256 * HEIGHT,
    usage: MAP_READ | BUFFER_COPY_DST,
  });
  device.queue.writeBuffer(viewBuffer, 0, createViewUniforms());
  device.queue.writeBuffer(cloudBuffer, 0, createCloudUniforms(density));
  device.queue.writeBuffer(
    densityBuffer,
    0,
    new Uint32Array(48).fill(density === 0 ? 0 : 0xffffffff),
  );
  const group0 = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: viewBuffer } }],
  });
  const group1 = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: source.createView() },
      { binding: 1, resource: device.createSampler() },
      { binding: 2, resource: { buffer: cloudBuffer } },
      { binding: 3, resource: depth.createView() },
      { binding: 4, resource: device.createSampler() },
      { binding: 5, resource: previousRadiance.createView() },
      { binding: 6, resource: previousTransmittance.createView() },
      { binding: 7, resource: previousDepth.createView() },
      { binding: 8, resource: { buffer: densityBuffer } },
    ],
  });
  const encoder = device.createCommandEncoder();
  const depthPass = encoder.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: depthValue,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  });
  depthPass.end();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: output.createView(),
        clearValue: [0, 0, 0, 1],
        loadOp: 'clear',
        storeOp: 'store',
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
    { buffer: readback, bytesPerRow: 256, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(MAP_MODE_READ);
  const bytes = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  source.destroy();
  depth.destroy();
  output.destroy();
  viewBuffer.destroy();
  cloudBuffer.destroy();
  densityBuffer.destroy();
  previousRadiance.destroy();
  previousTransmittance.destroy();
  previousDepth.destroy();
  readback.destroy();
  return {
    rows: Array.from({ length: HEIGHT }, (_, y) => bytes[y * 256] ?? 0),
    center: bytes[(HEIGHT >> 1) * 256 + (WIDTH >> 1) * 4] ?? 0,
  };
}

describe('CloudLayer framebuffer Y convention on Dawn', () => {
  it('keeps asymmetric color rows and depth-cut rays in one top-left convention', async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) return;
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: CLOUD_VIEW_FULLSCREEN_WGSL });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    const historyModule = device.createShaderModule({ code: CLOUD_HISTORY_FULLSCREEN_WGSL });
    await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: historyModule, entryPoint: 'vs_main' },
      fragment: {
        module: historyModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    const noCloud = await render(device, pipeline, 1, 0);
    expect(noCloud.rows).toEqual([20, 80, 140, 200]);
    expect(noCloud.center).toBe(140);
    const near = await render(device, pipeline, 0.1, 1);
    const far = await render(device, pipeline, 1, 1);
    expect(Math.abs(near.center - far.center)).toBeGreaterThan(2);
    device.destroy();
  });
});
