import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '../index';

/** A seed scope drops large resources' initial bytes; the tape still replays what the frame writes. */
export async function verifySeedScope() {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const sizes = [256, 4096];
  const buffers = sizes.map((size, index) => {
    const buffer = device.createBuffer({ size, usage: 0x0c }).unwrap();
    device.queue.writeBuffer(buffer, 0, new Uint8Array(size).fill(index + 7)).unwrap();
    return buffer;
  });
  const target = device.createBuffer({ size: 512, usage: 0x0c }).unwrap();
  try {
    await device.queue.onSubmittedWorkDone();
    const captured = recorder.captureFrame({ seed: { maxResourceBytes: 1024 } });
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    for (const [index, buffer] of buffers.entries())
      encoder.copyBufferToBuffer(buffer, 0, target, index * 256, 256);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    const tape = decodeTape((await captured).unwrap().bytes).unwrap();
    const bySize = (size: number) =>
      tape.bootstrap.filter(
        (resource) => (resource.create as { desc?: { size?: number } }).desc?.size === size,
      );
    const big = bySize(4096);
    expect(big.map((resource) => [resource.seed, resource.initialData.length])).toEqual([
      ['omitted', 0],
    ]);
    const small = bySize(256).filter((resource) => resource.initialData.length > 0);
    expect(small.length).toBeGreaterThan(0);
    expect(small.every((resource) => resource.seed === undefined)).toBe(true);
    expect(tape.blobs.reduce((total, blob) => total + blob.bytes.byteLength, 0)).toBeLessThan(4096);
    expect(buildFrameModel(tape).unseededResources).toContainEqual(
      expect.objectContaining({ resourceId: big[0]?.handleId, omitted: true }),
    );
    const freshDevice = (
      await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    const replay = (
      await openReplay(tape, { device: freshDevice, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const source = small[0]?.handleId;
      if (source === undefined) throw new Error('missing seeded buffer');
      const read = (await replay.readResource(source)).unwrap();
      expect(read.bytes.every((byte) => byte === 7)).toBe(true);
    } finally {
      (await replay.dispose()).unwrap();
    }
  } finally {
    for (const buffer of [...buffers, target]) device.destroyBuffer(buffer).unwrap();
    (await recorder.dispose()).unwrap();
  }
}
