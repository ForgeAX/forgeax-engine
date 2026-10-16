import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { expect, it } from 'vitest';
import { decodeTape } from '../protocol/codec';
import { readbackTexturePixels, readbackTexturePixelsBatch } from '../readback';
import { attachRecorder } from '../recorder/session';

it('captures the uploaded white material texel from a WebGL2 texture', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  await wgpu.ensureReady();
  const adapter = (await wgpu.requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  expect(device.caps.backendKind).toBe('wgpu-webgl2');
  const texture = device
    .createTexture({
      label: 'fallback-white-1x1',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: 0x01 | 0x02 | 0x04,
    })
    .unwrap();
  try {
    const paddedWhite = new Uint8Array(256);
    paddedWhite.set([255, 255, 255, 255]);
    device.queue
      .writeTexture(
        { texture },
        paddedWhite,
        { bytesPerRow: 256, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      )
      .unwrap();
    await device.queue.onSubmittedWorkDone();
    const pixels = await readbackTexturePixels(device, texture, 1, 1);
    expect(Array.from(pixels)).toEqual([255, 255, 255, 255]);
  } finally {
    device.destroyTexture(texture).unwrap();
    canvas.remove();
  }
});

it('retains the uploaded white texel in a WebGL2 recorder frame seed', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  await wgpu.ensureReady();
  const attached = attachRecorder({
    rhi: { ...wgpu.rhi, requestAdapter: () => wgpu.requestAdapter(undefined, canvas) },
    createShaderModule: wgpu.createShaderModule,
    createShaderModuleImmediate: wgpu.createShaderModuleImmediate,
  }).unwrap();
  const adapter = (await attached.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  expect(device.caps.backendKind).toBe('wgpu-webgl2');
  const texture = device
    .createTexture({
      label: 'fallback-white-1x1',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: 0x06,
    })
    .unwrap();
  const target = device.createBuffer({ size: 256, usage: 0x04 | 0x08 }).unwrap();
  try {
    const row = new Uint8Array(256);
    row.set([255, 255, 255, 255]);
    device.queue
      .writeTexture(
        { texture },
        row,
        { bytesPerRow: 256, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      )
      .unwrap();
    await device.queue.onSubmittedWorkDone();
    const pending = attached.captureFrame();
    (await attached.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: target, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    (await attached.frameBoundary()).unwrap();
    const capture = (await pending).unwrap();
    const tape = decodeTape(capture.bytes).unwrap();
    const seed = tape.bootstrap.find(
      (entry) =>
        (entry.create.desc as { label?: string } | undefined)?.label === 'fallback-white-1x1',
    );
    expect(seed).toBeDefined();
    const hash = seed?.initialData[0]?.hash;
    const blob = tape.blobs.find((entry) => entry.hash === hash);
    expect(Array.from(blob?.bytes ?? [])).toEqual([255, 255, 255, 255]);
  } finally {
    device.destroyTexture(texture).unwrap();
    device.destroyBuffer(target).unwrap();
    (await attached.dispose()).unwrap();
    canvas.remove();
  }
});

it('keeps uploaded WebGL2 texels when several textures share a snapshot batch', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  await wgpu.ensureReady();
  const adapter = (await wgpu.requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  expect(device.caps.backendKind).toBe('wgpu-webgl2');
  const textures = Array.from({ length: 16 }, (_, index) =>
    device
      .createTexture({
        label: `snapshot-${index}`,
        size: [1, 1],
        format: 'rgba8unorm',
        usage: 0x01 | 0x02 | 0x04,
      })
      .unwrap(),
  );
  try {
    textures.forEach((texture, index) => {
      const row = new Uint8Array(256);
      row.set([index + 1, 255, 255, 255]);
      device.queue
        .writeTexture(
          { texture },
          row,
          { bytesPerRow: 256, rowsPerImage: 1 },
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        )
        .unwrap();
    });
    await device.queue.onSubmittedWorkDone();
    const batch = await readbackTexturePixelsBatch(
      device,
      textures.map((texture, index) => ({
        handleId: String(index),
        texture,
        bytesPerBlock: 4,
        blockWidth: 1,
        blockHeight: 1,
        totalBytes: 4,
        slices: [{ layer: 0, mip: 0, width: 1, height: 1, byteOffset: 0, byteLength: 4 }],
      })),
    );
    expect(batch.ok, batch.ok ? undefined : JSON.stringify(batch.error)).toBe(true);
    if (batch.ok) {
      for (const [index] of textures.entries()) {
        const bytes = batch.value.get(String(index));
        expect(bytes).toBeDefined();
        if (bytes !== undefined)
          expect(Array.from(new Uint8Array(bytes))).toEqual([index + 1, 255, 255, 255]);
      }
    }
  } finally {
    for (const texture of textures) device.destroyTexture(texture).unwrap();
    canvas.remove();
  }
});

it('keeps a white texel when a large HDR target shares the snapshot batch', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  await wgpu.ensureReady();
  const adapter = (await wgpu.requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  expect(device.caps.backendKind).toBe('wgpu-webgl2');
  const white = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x07 }).unwrap();
  const hdr = device
    .createTexture({ size: [640, 360], format: 'rgba16float', usage: 0x07 })
    .unwrap();
  try {
    const row = new Uint8Array(256);
    row.set([255, 255, 255, 255]);
    device.queue
      .writeTexture(
        { texture: white },
        row,
        { bytesPerRow: 256, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      )
      .unwrap();
    await device.queue.onSubmittedWorkDone();
    const batch = await readbackTexturePixelsBatch(device, [
      {
        handleId: 'white',
        texture: white,
        bytesPerBlock: 4,
        blockWidth: 1,
        blockHeight: 1,
        totalBytes: 4,
        slices: [{ layer: 0, mip: 0, width: 1, height: 1, byteOffset: 0, byteLength: 4 }],
      },
      {
        handleId: 'hdr',
        texture: hdr,
        bytesPerBlock: 8,
        blockWidth: 1,
        blockHeight: 1,
        totalBytes: 640 * 360 * 8,
        slices: [
          { layer: 0, mip: 0, width: 640, height: 360, byteOffset: 0, byteLength: 640 * 360 * 8 },
        ],
      },
    ]);
    expect(batch.ok, batch.ok ? undefined : JSON.stringify(batch.error)).toBe(true);
    if (batch.ok) {
      const bytes = batch.value.get('white');
      expect(bytes).toBeDefined();
      if (bytes !== undefined)
        expect(Array.from(new Uint8Array(bytes))).toEqual([255, 255, 255, 255]);
    }
  } finally {
    device.destroyTexture(white).unwrap();
    device.destroyTexture(hdr).unwrap();
    canvas.remove();
  }
});
