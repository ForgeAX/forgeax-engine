import * as webgl from '@forgeax/engine-rhi-wgpu';
import { expect, it } from 'vitest';
import type { Tape } from '../protocol/types';
import { wrap } from '../recorder';
import { readReplayResource } from '../replay/readback';
import { ResourceTable } from '../replay/resources';
import { openReplay } from '../replay/session';

it.each([
  'depth16unorm',
  'depth24plus',
  'depth24plus-stencil8',
  'depth32float',
  'depth32float-stencil8',
] as const)('reads exact initialized zero depth from %s on real WebGL', async (format) => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  await webgl.ensureReady();
  const adapter = (await webgl.requestAdapter(undefined, canvas)).unwrap();
  const device = (
    await adapter.requestDevice({
      requiredFeatures: format === 'depth32float-stencil8' ? ['depth32float-stencil8'] : [],
    })
  ).unwrap();
  expect(device.caps.backendKind).toBe('wgpu-webgl2');
  const tape: Tape = {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [
      {
        handleId: 'texture:depth',
        kind: 'texture',
        create: {
          kind: 'createTexture',
          handleId: 'texture:depth',
          desc: {
            label: 'depth-readback-regression',
            size: { width: 4, height: 4, depthOrArrayLayers: 1 },
            format,
            dimension: '2d',
            mipLevelCount: 1,
            sampleCount: 1,
            usage: 0x15,
          },
        },
        initialData: [],
      },
    ],
    events: [],
    blobs: [],
  };
  const replay = (
    await openReplay(tape, { device, createShaderModule: webgl.createShaderModule })
  ).unwrap();
  try {
    const read = (
      await replay.readResource('texture:depth', {
        mipLevel: 0,
        arrayLayer: 0,
        aspect: 'depth-only',
      })
    ).unwrap();
    expect(read.bytes.byteLength).toBe(4 * 4 * 4);
    expect([...new Uint32Array(read.bytes.buffer, read.bytes.byteOffset, 16)]).toEqual(
      Array(16).fill(0),
    );
    expect(read.provenance.resourceId).toBe('texture:depth');
    const invalidAspect = await replay.readResource('texture:depth', {
      mipLevel: 0,
      arrayLayer: 0,
      aspect: format.endsWith('-stencil8') ? 'all' : 'stencil-only',
    });
    expect(invalidAspect.ok).toBe(false);
    if (!invalidAspect.ok) expect(invalidAspect.error.code).toBe('readback-unsupported');
  } finally {
    (await replay.dispose()).unwrap();
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  }
});

it.each([
  'depth32float',
  'depth32float-stencil8',
] as const)('preserves float bits through %s layer/mip readback', async (format) => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  await webgl.ensureReady();
  const device = (
    await (await webgl.requestAdapter(undefined, canvas)).unwrap().requestDevice({
      requiredFeatures: format === 'depth32float-stencil8' ? ['depth32float-stencil8'] : [],
    })
  ).unwrap();
  const descriptor = {
    size: { width: 4, height: 4, depthOrArrayLayers: 2 },
    format,
    mipLevelCount: 2,
    usage: 0x15,
  };
  const texture = device.createTexture(descriptor).unwrap();
  const table = new ResourceTable(device);
  table.set('texture:depth', { kind: 'texture', value: texture }, { desc: descriptor }).unwrap();
  try {
    const bits = new Uint32Array([
      0, 0x00000001, 0x007fffff, 0x00800000, 0x3c23d70a, 0x3f000001, 0x3f7fffff, 0x3f800000,
    ]);
    const values = new Float32Array(bits.buffer);
    for (const [index, value] of values.entries()) {
      const arrayLayer = index % 2;
      const mipLevel = Math.floor(index / 2) % 2;
      const view = device
        .createTextureView(texture, {
          dimension: '2d',
          baseArrayLayer: arrayLayer,
          arrayLayerCount: 1,
          baseMipLevel: mipLevel,
          mipLevelCount: 1,
          aspect: 'all',
        })
        .unwrap();
      const encoder = device.createCommandEncoder({}).unwrap();
      encoder
        .beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
            depthClearValue: value,
            ...(format === 'depth32float-stencil8' ? { stencilReadOnly: true } : {}),
          },
        })
        .end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const subresource = { mipLevel, arrayLayer, aspect: 'depth-only' as const };
      const result = (
        await readReplayResource(
          device,
          table,
          'texture:depth',
          subresource,
          webgl.createShaderModule,
        )
      ).unwrap();
      const pixels = (4 >> mipLevel) ** 2;
      expect
        .soft(
          [...new Uint32Array(result.bytes.buffer, result.bytes.byteOffset, pixels)],
          `bits ${bits[index]?.toString(16)}, layer ${arrayLayer}, mip ${mipLevel}`,
        )
        .toEqual(Array(pixels).fill(bits[index]));
      expect(result.provenance.subresource).toEqual(subresource);
    }
  } finally {
    table.dispose().unwrap();
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  }
});

it.each([
  'single',
  'batch',
] as const)('snapshots retained depth32float layers and mips through the %s path on WebGL2', async (mode) => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  await webgl.ensureReady();
  const recorder = wrap(webgl.rhi, webgl.createShaderModule);
  const device = (
    await (await recorder.requestAdapter(undefined, canvas)).unwrap().requestDevice()
  ).unwrap();
  const texture = device
    .createTexture({
      size: { width: 4, height: 4, depthOrArrayLayers: 2 },
      format: 'depth32float',
      mipLevelCount: 2,
      usage: 0x14,
    })
    .unwrap();
  try {
    expect(device.caps.backendKind).toBe('wgpu-webgl2');
    const expected: number[] = [];
    const encoder = device.createCommandEncoder({}).unwrap();
    for (let layer = 0; layer < 2; layer++) {
      for (let mip = 0; mip < 2; mip++) {
        const value = (layer * 2 + mip + 1) / 4;
        expected.push(...Array((4 >> mip) ** 2).fill(value));
        const view = device
          .createTextureView(texture, {
            dimension: '2d',
            baseArrayLayer: layer,
            arrayLayerCount: 1,
            baseMipLevel: mip,
            mipLevelCount: 1,
            aspect: 'depth-only',
          })
          .unwrap();
        encoder
          .beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
              view,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
              depthClearValue: value,
            },
          })
          .end();
      }
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const handleId = [...recorder.descriptorTable().keys()][0];
    if (handleId === undefined) throw new Error('missing retained depth');
    recorder.arm(1).unwrap();
    if (mode === 'single') (await recorder.snapshotResource(handleId)).unwrap();
    else (await recorder.snapshotAllLiveResources()).unwrap();
    const seed = recorder
      .getEvents()
      .find((event) => event.kind === 'initialData' && event.handleId === handleId);
    if (seed?.kind !== 'initialData') throw new Error('missing depth seed');
    const bytes = recorder.getBlobPool().get(seed.dataHash);
    if (bytes === undefined) throw new Error('missing depth bytes');
    expect([...new Float32Array(bytes)]).toEqual(expected);
  } finally {
    device.destroyTexture(texture).unwrap();
    recorder.transitionToError();
    recorder.disposeError();
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  }
});
