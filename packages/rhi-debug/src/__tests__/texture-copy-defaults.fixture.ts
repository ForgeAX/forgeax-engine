import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '../index';

/** Omitted layout fields must stay omitted through both texture copy directions. */
export async function verifyTextureCopyDefaults(height: number) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const captured = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const size = height * 256;
  const source = device.createBuffer({ size, usage: 12 }).unwrap();
  const output = device.createBuffer({ size, usage: 140 }).unwrap();
  const texture = device
    .createTexture({ size: { width: 1, height }, format: 'r32uint', usage: 3 })
    .unwrap();
  try {
    const seed = new Uint32Array(size / 4);
    seed[0] = 37;
    if (height > 1) seed[64] = 91;
    device.queue.writeBuffer(source, 0, seed).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: output } } }],
      })
      .unwrap();
    const module = (
      await recorder.backend.createShaderModule(device, {
        code: `
      @group(0) @binding(0) var<storage, read_write> values: array<u32>;
      @compute @workgroup_size(1) fn main() {
        values[0] += 10u;
        if (arrayLength(&values) > 64u) { values[64] += 10u; }
      }`,
      })
    ).unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        compute: { module, entryPoint: 'main' },
      })
      .unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const layoutFields = height === 1 ? {} : { bytesPerRow: 256 };
    // The legacy upload overload still spells native handles; these are RHI-owned.
    encoder.copyBufferToTexture(
      { buffer: source, ...layoutFields } as never,
      { texture } as never,
      { width: 1, height },
    );
    encoder.copyTextureToBuffer({ texture }, { buffer: output, ...layoutFields } as never, {
      width: 1,
      height,
    });
    const pass = encoder.beginComputePass({});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const live = await read(device, output, size);
    expect(new Uint32Array(live.buffer)[0]).toBe(47);
    if (height > 1) expect(new Uint32Array(live.buffer)[64]).toBe(101);
    (await recorder.frameBoundary()).unwrap();
    const tape = decodeTape((await captured).unwrap().bytes).unwrap();
    const work = buildFrameModel(tape).works[0];
    const resource = work?.bindings[0]?.resourceId;
    assert(work && resource);
    device.destroyBuffer(source).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyTexture(texture).unwrap();
    const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const replayed = (await replay.readResourceAtWork(resource, work.workIndex)).unwrap();
      expect(Array.from(replayed.bytes)).toEqual(Array.from(live));
    } finally {
      (await replay.dispose()).unwrap();
    }
  } finally {
    (await recorder.dispose()).unwrap();
  }
}

async function read(device: RhiDevice, source: Buffer, size: number) {
  const buffer = device.createBuffer({ size, usage: 9 }).unwrap();
  try {
    const encoder = device.createCommandEncoder({}).unwrap();
    encoder.copyBufferToBuffer(source, 0, buffer, 0, size);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await buffer.mapAsync(1)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap()).slice();
    mapped.unmap();
    return bytes;
  } finally {
    device.destroyBuffer(buffer).unwrap();
  }
}
