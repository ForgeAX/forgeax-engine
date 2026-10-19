import type { TextureDescriptor } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '../index';

/** Snapshot and readback must agree with the GPU's omitted-height default. */
export async function verifyTextureExtent(size: TextureDescriptor['size']) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const source = device
    .createTexture({ label: 'extent-source', size, format: 'rgba8unorm', usage: 6 })
    .unwrap();
  const target = device.createTexture({ size: [4, 1], format: 'rgba8unorm', usage: 6 }).unwrap();
  const pixels = Uint8Array.from({ length: 16 }, (_, i) => i * 13);
  try {
    device.queue.writeTexture({ texture: source }, pixels, {}, [4]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const pending = recorder.captureFrame();
    const started = await recorder.frameBoundary();
    if (!started.ok) {
      await pending;
      throw started.error;
    }
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyTextureToTexture({ texture: source }, { texture: target }, [4]);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    (await recorder.frameBoundary()).unwrap();
    const tape = decodeTape((await pending).unwrap().bytes).unwrap();
    const captured = tape.bootstrap.find((resource) => {
      const desc = resource.create.desc;
      return (
        resource.create.kind === 'createTexture' &&
        desc !== null &&
        typeof desc === 'object' &&
        'label' in desc &&
        desc.label === 'extent-source'
      );
    });
    if (!captured) throw new Error('source texture missing from bootstrap');
    expect(captured.initialData.reduce((sum, slice) => sum + slice.byteLength, 0)).toBe(16);
    const model = buildFrameModel(tape);
    expect(
      model.resourceLifecycle.resources.find((resource) => resource.handleId === captured.handleId)
        ?.byteEstimate,
    ).toMatchObject({ status: 'known', bytes: 16 });
    const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const read = (await replay.readResource(captured.handleId)).unwrap();
      expect([...read.bytes]).toEqual([...pixels]);
      expect(read).toMatchObject({ width: 4, height: 1 });
    } finally {
      (await replay.dispose()).unwrap();
    }
  } finally {
    device.destroyTexture(source).unwrap();
    device.destroyTexture(target).unwrap();
    (await recorder.dispose()).unwrap();
  }
}
