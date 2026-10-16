import type { Buffer } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect, vi } from 'vitest';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  readbackTexturePixels,
} from '../index';
import { wrap } from '../recorder';

/** Real GPU regression: array/mip seeds exceed one staging batch. */
export async function verifySnapshotMemory() {
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const sourceDevice = (await adapter.requestDevice()).unwrap();
  const createBuffer = sourceDevice.createBuffer.bind(sourceDevice);
  const destroyBuffer = sourceDevice.destroyBuffer.bind(sourceDevice);
  const staging = new Map<Buffer, number>();
  let currentBytes = 0,
    peakBytes = 0;
  Object.defineProperty(sourceDevice, 'createBuffer', {
    configurable: true,
    value: (desc: Parameters<typeof createBuffer>[0]) => {
      const result = createBuffer(desc);
      if (result.ok && desc.usage === 9 && desc.size !== undefined) {
        staging.set(result.value, desc.size);
        currentBytes += desc.size;
        peakBytes = Math.max(peakBytes, currentBytes);
      }
      return result;
    },
  });
  Object.defineProperty(sourceDevice, 'destroyBuffer', {
    configurable: true,
    value: (buffer: Buffer) => {
      currentBytes -= staging.get(buffer) ?? 0;
      staging.delete(buffer);
      return destroyBuffer(buffer);
    },
  });
  const recorder = attachRecorder({
    ...webgpu,
    rhi: {
      ...webgpu.rhi,
      requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(sourceDevice) }),
    },
  }).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const textures = Array.from({ length: 3 }, (_, i) => {
    const texture = device
      .createTexture({
        size: { width: 2048, height: 1024, depthOrArrayLayers: 2 },
        mipLevelCount: 3,
        format: 'rgba8unorm',
        usage: 6,
      })
      .unwrap();
    device.queue
      .writeTexture(
        { texture, mipLevel: 2, origin: { x: 0, y: 0, z: 1 } },
        new Uint8Array([31 + i * 63, 17, 93, 255]),
        {},
        { width: 1, height: 1 },
      )
      .unwrap();
    return texture;
  });
  const target = device
    .createTexture({ size: { width: 3, height: 1 }, format: 'rgba8unorm', usage: 17 })
    .unwrap();
  const targetView = device.createTextureView(target, {}).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: textures.map((_, binding) => ({
        binding,
        visibility: 2,
        texture: { sampleType: 'float' as const, viewDimension: '2d-array' as const },
      })),
    })
    .unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: textures.map((texture, binding) => ({
        binding,
        resource: {
          kind: 'textureView' as const,
          value: device.createTextureView(texture, { dimension: '2d-array' }).unwrap(),
        },
      })),
    })
    .unwrap();
  const shader = (
    await recorder.backend.createShaderModule(device, {
      code: `
    @group(0) @binding(0) var a: texture_2d_array<f32>;
    @group(0) @binding(1) var b: texture_2d_array<f32>;
    @group(0) @binding(2) var c: texture_2d_array<f32>;
    @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
      return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);
    }
    @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
      if (p.x < 1.0) {return textureLoad(a,vec2i(0),1,2);}
      if (p.x < 2.0) {return textureLoad(b,vec2i(0),1,2);}
      return textureLoad(c,vec2i(0),1,2);
    }`,
    })
  ).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: { module: shader, entryPoint: 'vs', buffers: [] },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    })
    .unwrap();
  const draw = () => {
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
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
  };
  let retired = false;
  const retire = () => {
    if (retired) return;
    retired = true;
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    device.destroyTexture(target).unwrap();
  };
  try {
    const rejected = recorder.captureFrame({ byteBudget: 66_060_299 });
    expect((await recorder.frameBoundary()).ok).toBe(false);
    expect(await rejected).toMatchObject({ ok: false, error: { code: 'capture-snapshot-failed' } });
    expect(peakBytes).toBe(0);
    const pending = recorder.captureFrame({ byteBudget: 128 * 1024 * 1024 });
    (await recorder.frameBoundary()).unwrap();
    expect(peakBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(currentBytes).toBe(0);
    draw();
    await device.queue.onSubmittedWorkDone();
    const first = await readbackTexturePixels(sourceDevice, target, 3, 1);
    expect([...first]).toEqual([31, 17, 93, 255, 94, 17, 93, 255, 157, 17, 93, 255]);
    // Only this view belongs to the upload; unrelated backing bytes and later
    // caller mutation must not enter the captured blob.
    const backing = new Uint8Array([255, 0, 0, 255, 7, 211, 19, 255, 0, 0, 255, 255]);
    device.queue
      .writeTexture(
        {
          texture: textures[0] as NonNullable<(typeof textures)[0]>,
          mipLevel: 2,
          origin: { x: 0, y: 0, z: 1 },
        },
        backing.subarray(4, 8),
        {},
        { width: 1, height: 1 },
      )
      .unwrap();
    backing.fill(0);
    draw();
    await device.queue.onSubmittedWorkDone();
    const second = await readbackTexturePixels(sourceDevice, target, 3, 1);
    expect([...second]).toEqual([7, 211, 19, 255, 94, 17, 93, 255, 157, 17, 93, 255]);
    (await recorder.frameBoundary()).unwrap();
    const captured = (await pending).unwrap();
    retire();
    const tape = decodeTape(captured.bytes).unwrap();
    const model = buildFrameModel(tape);
    expect(model.works).toHaveLength(2);
    const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      for (const [i, expected] of [first, second].entries()) {
        const work = model.works[i];
        const attachment = work?.attachments?.colorViewHandleIds[0];
        if (!work || !attachment) throw new Error('missing texture consumer');
        const read = (await replay.readResourceAtWork(attachment, work.workIndex)).unwrap();
        expect([...read.bytes]).toEqual([...expected]);
      }
    } finally {
      (await replay.dispose()).unwrap();
    }
    return {
      bytes: captured.bytes,
      digest: captured.digest,
      peakStagingBytes: peakBytes,
      retainedStagingBytes: currentBytes,
      payloadBytes: tape.blobs.reduce((n, b) => n + b.bytes.byteLength, 0),
    };
  } finally {
    retire();
    (await recorder.dispose()).unwrap();
  }
}

export async function verifyCancelledSnapshotHash() {
  const recorder = wrap(webgpu.rhi);
  const device = (await (await recorder.requestAdapter()).unwrap().requestDevice()).unwrap();
  const buffer = device.createBuffer({ size: 16, usage: 0x80 | 0x0c }).unwrap();
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hashing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
    started();
    await pending;
    return digest(algorithm, data);
  });
  try {
    recorder.arm(1).unwrap();
    const first = recorder.snapshotAllLiveResources();
    expect(await Promise.race([hashing.then(() => true), first])).toBe(true);
    recorder.transitionToError();
    recorder.disposeError();
    recorder.arm(1).unwrap();
    release();
    expect(await first).toMatchObject({ ok: false, error: { code: 'capture-snapshot-failed' } });
    expect(recorder.getState()).toBe('armed');
    expect(recorder.getBlobPool().size).toBe(0);
    expect((await recorder.snapshotAllLiveResources()).ok).toBe(true);
    expect(recorder.getBlobPool().size).toBe(1);
  } finally {
    release();
    spy.mockRestore();
    device.destroyBuffer(buffer).unwrap();
    recorder.transitionToError();
    recorder.disposeError();
  }
}
