import type { RhiComputePipelineOps } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  depthImage,
  openReplay,
  readbackImage,
} from '../index';
import type { Tape } from '../protocol/types';

const BUFFER = { COPY_SRC: 0x04, COPY_DST: 0x08, UNIFORM: 0x40, STORAGE: 0x80 };
const TEXTURE = {
  COPY_SRC: 0x01,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};

const COMPUTE = `
@group(0) @binding(0) var<uniform> scale: vec4u;
@group(0) @binding(1) var<storage, read_write> values: array<u32>;
@group(0) @binding(2) var image: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  values[id.x] = id.x * scale.x + 1u;
  // Exact UNORM codes keep this work-output test independent of half-code rounding.
  textureStore(image, vec2u(id.x, 0u), vec4f(f32(id.x * 64u) / 255.0, 128.0 / 255.0, 1.0, 1.0));
}`;

const DEPTH_ONLY = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0.25, 1);
}`;

async function replayDevice() {
  return (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
}

async function openFresh(tape: Tape) {
  return (
    await openReplay(tape, {
      device: await replayDevice(),
      createShaderModule: webgpu.createShaderModule,
    })
  ).unwrap();
}

/** A compute dispatch's storage buffer and storage texture are first-class work outputs. */
export async function verifyComputeOutputs() {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const uniform = device
    .createBuffer({ size: 16, usage: BUFFER.UNIFORM | BUFFER.COPY_DST })
    .unwrap();
  device.queue.writeBuffer(uniform, 0, new Uint32Array([3, 0, 0, 0])).unwrap();
  const values = device
    .createBuffer({ size: 16, usage: BUFFER.STORAGE | BUFFER.COPY_SRC })
    .unwrap();
  const texture = device
    .createTexture({
      size: { width: 4, height: 1 },
      format: 'rgba8unorm',
      usage: TEXTURE.STORAGE_BINDING | TEXTURE.COPY_SRC,
    })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const shader = (await recorder.backend.createShaderModule(device, { code: COMPUTE })).unwrap();
  const pipeline = device
    .createComputePipeline({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } })
    .unwrap();
  const group = device
    .createBindGroup({
      layout: (pipeline as unknown as RhiComputePipelineOps).getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } },
        { binding: 1, resource: { kind: 'buffer', value: { buffer: values } } },
        { binding: 2, resource: { kind: 'textureView', value: view } },
      ],
    })
    .unwrap();
  try {
    await device.queue.onSubmittedWorkDone();
    const captured = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    const tape = decodeTape((await captured).unwrap().bytes).unwrap();
    const work = buildFrameModel(tape).works[0];
    expect(work?.bindings.map((binding) => binding.access)).toEqual([
      'read',
      'read-write',
      'write',
    ]);
    const replay = await openFresh(tape);
    try {
      const inspection = (await replay.inspectWork(0, ['outputs', 'pixels'])).unwrap();
      const outputs = inspection.outputs ?? [];
      expect(outputs.map(({ name, role }) => ({ name, role }))).toEqual([
        { name: '@group(0)@binding(1)', role: 'storage-buffer' },
        { name: '@group(0)@binding(2)', role: 'storage-texture' },
      ]);
      const buffer = outputs[0]?.result;
      if (buffer?.ok !== true) throw new Error('storage buffer output was not read');
      expect([...new Uint32Array(buffer.value.bytes.slice().buffer)]).toEqual([1, 4, 7, 10]);
      const pixels = inspection.attachment;
      expect(pixels?.format).toBe('rgba8unorm');
      expect([...(pixels?.bytes ?? [])]).toEqual([
        0, 128, 255, 255, 64, 128, 255, 255, 128, 128, 255, 255, 192, 128, 255, 255,
      ]);
      expect(pixels?.provenance.selectedWorkIndex).toBe(0);
    } finally {
      (await replay.dispose()).unwrap();
    }
  } finally {
    device.destroyBuffer(uniform).unwrap();
    device.destroyBuffer(values).unwrap();
    device.destroyTexture(texture).unwrap();
    (await recorder.dispose()).unwrap();
  }
}

/** A depth-only pass into one shadow-array layer reads back as a depth image of that layer. */
export async function verifyDepthOnlyLayerOutput() {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const depth = device
    .createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 2 },
      format: 'depth32float',
      usage: TEXTURE.RENDER_ATTACHMENT | TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_SRC,
    })
    .unwrap();
  const layerView = (layer: number) =>
    device
      .createTextureView(depth, {
        dimension: '2d',
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        aspect: 'depth-only',
      })
      .unwrap();
  const views = [layerView(0), layerView(1)];
  const shader = (await recorder.backend.createShaderModule(device, { code: DEPTH_ONLY })).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    })
    .unwrap();
  try {
    await device.queue.onSubmittedWorkDone();
    const captured = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    for (const [layer, view] of views.entries()) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
        },
      });
      if (layer === 1) {
        pass.setPipeline(pipeline);
        pass.draw(3);
      }
      pass.end();
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    const tape = decodeTape((await captured).unwrap().bytes).unwrap();
    const model = buildFrameModel(tape);
    const work = model.works.find((candidate) => candidate.drawCall !== null);
    if (work === undefined) throw new Error('missing depth-only draw');
    const replay = await openFresh(tape);
    try {
      const inspection = (await replay.inspectWork(work.workIndex, ['outputs', 'pixels'])).unwrap();
      expect(inspection.outputs?.map(({ name, role }) => ({ name, role }))).toEqual([
        { name: 'depth', role: 'depth' },
      ]);
      const attachment = inspection.attachment;
      if (attachment === undefined) throw new Error('depth-only work has no pixels');
      const raw = readbackImage(attachment).unwrap();
      expect(raw.width).toBe(4);
      const grey = depthImage(raw);
      expect([...grey.data.subarray(0, 4)]).toEqual([0.25, 0.25, 0.25, 1]);
      const linear = depthImage(raw, { near: 1, far: 100 });
      expect(linear.data[0]).toBeCloseTo(100 / (100 - 0.25 * 99), 5);
      const reversed = depthImage(raw, { near: 1, far: Number.POSITIVE_INFINITY, reverseZ: true });
      expect(reversed.data[0]).toBeCloseTo(4, 5);
    } finally {
      (await replay.dispose()).unwrap();
    }
  } finally {
    device.destroyTexture(depth).unwrap();
    (await recorder.dispose()).unwrap();
  }
}
