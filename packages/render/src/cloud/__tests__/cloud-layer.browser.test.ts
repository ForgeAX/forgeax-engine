/// <reference types="@webgpu/types" />

import { describe, expect, it } from 'vitest';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import {
  CLOUD_RESOLVE_FULLSCREEN_WGSL,
  CLOUD_TRANSPORT_FULLSCREEN_WGSL,
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
const UNIFORM = 0x0040;
const MAP_MODE_READ = 0x0001;

function identity(target: Float32Array, offset: number): void {
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 15] = 1;
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

function createCloudUniforms(): Float32Array {
  const data = new Float32Array(CLOUD_VIEW_PARAMS_BYTES / Float32Array.BYTES_PER_ELEMENT);
  data[0] = -1;
  data[1] = 2;
  data[2] = 1;
  data[3] = 1;
  data[4] = 0;
  data[5] = 0;
  data[6] = 10;
  data[7] = 7;
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

async function render(device: GPUDevice, pipeline: GPURenderPipeline, depthValue: number) {
  const source = createSource(device);
  const depth = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'depth32float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  });
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
  // Resolution 4 stores weather, body and erosion as three contiguous planes.
  // Keep the browser ABI probe honest even when coverage is zero and the
  // density path returns early.
  const densityBuffer = device.createBuffer({ size: 192, usage: 0x0080 | BUFFER_COPY_DST });
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
  const readback = device.createBuffer({ size: 256 * HEIGHT, usage: MAP_READ | BUFFER_COPY_DST });
  device.queue.writeBuffer(viewBuffer, 0, createViewUniforms());
  device.queue.writeBuffer(cloudBuffer, 0, createCloudUniforms());
  device.queue.writeBuffer(densityBuffer, 0, new Uint32Array(48).fill(0));
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
  for (const resource of [
    source,
    depth,
    output,
    previousRadiance,
    previousTransmittance,
    previousDepth,
  ]) {
    resource.destroy();
  }
  for (const buffer of [viewBuffer, cloudBuffer, densityBuffer, readback]) buffer.destroy();
  return {
    rows: Array.from({ length: HEIGHT }, (_, y) => bytes[y * 256] ?? 0),
    center: bytes[(HEIGHT >> 1) * 256 + (WIDTH >> 1) * 4] ?? 0,
  };
}

async function renderResolveForeground(device: GPUDevice, pipeline: GPURenderPipeline) {
  const source = createSource(device);
  const sceneDepth = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'depth32float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  });
  const currentRadiance = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'rgba16float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  });
  const currentTransmittance = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'rgba16float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  });
  const currentDepth = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: 'rgba16float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT,
  });
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
  const readback = device.createBuffer({ size: 256 * HEIGHT, usage: MAP_READ | BUFFER_COPY_DST });
  device.queue.writeBuffer(viewBuffer, 0, createViewUniforms());
  device.queue.writeBuffer(cloudBuffer, 0, createCloudUniforms());
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  device.pushErrorScope('validation');
  const group0 = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: viewBuffer } }],
  });
  const group1 = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: source.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: cloudBuffer } },
      { binding: 3, resource: sceneDepth.createView() },
      { binding: 5, resource: currentRadiance.createView() },
      { binding: 6, resource: currentTransmittance.createView() },
      { binding: 7, resource: currentDepth.createView() },
      { binding: 8, resource: previousRadiance.createView() },
      { binding: 9, resource: previousTransmittance.createView() },
      { binding: 10, resource: previousDepth.createView() },
    ],
  });
  const bindGroupError = await device.popErrorScope();
  if (bindGroupError !== null) throw new Error(bindGroupError.message);
  device.pushErrorScope('validation');
  const encoder = device.createCommandEncoder();
  const depthPass = encoder.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: sceneDepth.createView(),
      depthClearValue: 0.5,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  });
  depthPass.end();
  const seedPass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: currentRadiance.createView(),
        clearValue: [1, 0, 0, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
      {
        view: currentTransmittance.createView(),
        clearValue: [0.5, 0, 0, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
      {
        view: currentDepth.createView(),
        clearValue: [0, 0, 2, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  });
  seedPass.end();
  const seedHistoryPass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: previousRadiance.createView(),
        clearValue: [0, 0, 0, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
      {
        view: previousTransmittance.createView(),
        clearValue: [1, 0, 0, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
      {
        view: previousDepth.createView(),
        clearValue: [0, 0, 2, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  });
  seedHistoryPass.end();
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
  const validationError = await device.popErrorScope();
  if (validationError !== null) throw new Error(validationError.message);
  await readback.mapAsync(MAP_MODE_READ);
  const bytes = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  for (const resource of [
    source,
    sceneDepth,
    currentRadiance,
    currentTransmittance,
    currentDepth,
    previousRadiance,
    previousTransmittance,
    previousDepth,
    output,
  ]) {
    resource.destroy();
  }
  for (const buffer of [viewBuffer, cloudBuffer, readback]) buffer.destroy();
  return {
    rows: Array.from({ length: HEIGHT }, (_, y) => bytes[y * 256] ?? 0),
    center: bytes[(HEIGHT >> 1) * 256 + (WIDTH >> 1) * 4] ?? 0,
  };
}

describe('CloudLayer browser WebGPU readback', () => {
  it('renders the authored cloud transport on a live browser device', async () => {
    expect(navigator.gpu).toBeDefined();
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    if (adapter === null) return;
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: CLOUD_VIEW_FULLSCREEN_WGSL });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    const transportModule = device.createShaderModule({ code: CLOUD_TRANSPORT_FULLSCREEN_WGSL });
    await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: transportModule, entryPoint: 'vs_main' },
      fragment: {
        module: transportModule,
        entryPoint: 'fs_transport',
        targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    const resolveModule = device.createShaderModule({ code: CLOUD_RESOLVE_FULLSCREEN_WGSL });
    const resolvePipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: resolveModule, entryPoint: 'vs_main' },
      fragment: {
        module: resolveModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    const noCloud = await render(device, pipeline, 1);
    expect(noCloud.rows).toEqual([20, 80, 140, 200]);
    expect(noCloud.center).toBe(140);
    const foreground = await renderResolveForeground(device, resolvePipeline);
    expect(foreground.center).toBe(140);
    device.destroy();
  });
});
