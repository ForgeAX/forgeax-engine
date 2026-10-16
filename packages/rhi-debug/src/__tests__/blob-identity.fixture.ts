import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '../index';

/** These different, equally sized payloads collide under the former DJB2 blob key. */
export async function verifyBlobIdentity() {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const payloads = [new Uint8Array([0, 33, 0, 0]), new Uint8Array([1, 0, 0, 0])];
  const buffers = payloads.map((bytes) => {
    const buffer = device.createBuffer({ size: 4, usage: 0x88 }).unwrap();
    device.queue.writeBuffer(buffer, 0, bytes).unwrap();
    return buffer;
  });
  const layout = device
    .createBindGroupLayout({
      entries: buffers.map((_, binding) => ({
        binding,
        visibility: 2,
        buffer: { type: 'read-only-storage' as const },
      })),
    })
    .unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: buffers.map((buffer, binding) => ({
        binding,
        resource: { kind: 'buffer' as const, value: { buffer, size: 4 } },
      })),
    })
    .unwrap();
  const shader = (
    await recorder.backend.createShaderModule(device, {
      code: `
      @group(0) @binding(0) var<storage, read> left: array<u32>;
      @group(0) @binding(1) var<storage, read> right: array<u32>;
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
        return vec4f(p[i], 0, 1);
      }
      @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) u32 {
        return select(left[0], right[0], p.x > 1.0);
      }`,
    })
  ).unwrap();
  const texture = device
    .createTexture({
      size: { width: 2, height: 1 },
      format: 'r32uint',
      usage: 0x11,
    })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'r32uint' }] },
    })
    .unwrap();
  try {
    await device.queue.onSubmittedWorkDone();
    const captured = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    const tape = decodeTape((await captured).unwrap().bytes).unwrap();
    const work = buildFrameModel(tape).works[0];
    if (work?.attachments?.colorViewHandleIds[0] === undefined)
      throw new Error('missing blob consumer');
    const freshDevice = (
      await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    const replay = (
      await openReplay(tape, { device: freshDevice, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const pixels = (
        await replay.readResourceAtWork(work.attachments.colorViewHandleIds[0], work.workIndex)
      ).unwrap();
      expect([...new Uint32Array(pixels.bytes.buffer, pixels.bytes.byteOffset, 2)]).toEqual([
        8448, 1,
      ]);
    } finally {
      (await replay.dispose()).unwrap();
    }
  } finally {
    for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
    device.destroyTexture(texture).unwrap();
    (await recorder.dispose()).unwrap();
  }
}
