import type { TextureFormat } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { createRendererObservationCaptureOwner } from '../assembly/webgpu-renderer-observation-owner';
import { encodeFrameObservationCapture } from '../record/observation-capture';
import type { FrameObservationDomain } from '../render-contract';

it.each([
  ['rgba8unorm', 'final-display', 3840],
  ['rgba16float', 'linear-hdr', 7424],
  ['rgba32float', 'linear-hdr', 14592],
  ['rgba32uint', 'visible-surface', 14592],
] satisfies Array<
  [TextureFormat, FrameObservationDomain, number]
>)('records the actual %s observation texel layout', async (format, domain, bytesPerRow) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = device
    .createTexture({
      size: { width: 900, height: 2, depthOrArrayLayers: 1 },
      format,
      dimension: '2d',
      mipLevelCount: 1,
      sampleCount: 1,
      usage: 0x11,
    })
    .unwrap();
  const owner = createRendererObservationCaptureOwner((error) => {
    throw error;
  });
  const encoder = device.createCommandEncoder().unwrap();
  const copy = vi.spyOn(encoder, 'copyTextureToBuffer');
  encodeFrameObservationCapture(
    {
      device,
      observationCaptureOwner: owner.observationCaptureOwner,
      observationCaptureDomains: [domain],
    },
    encoder,
    {
      texture,
      format,
      domain,
      width: 900,
      height: 2,
      frameNumber: 17,
      graphGeneration: 9,
      ...(domain === 'visible-surface' ? { surfaceRecords: new Uint32Array(0) } : {}),
    },
  );
  const captures = owner.observationCaptureOwner.consume(17);
  expect(captures).toHaveLength(1);
  expect(captures[0]).toMatchObject({ format, width: 900, height: 2, bytesPerRow });
  expect(copy).toHaveBeenCalledExactlyOnceWith(
    { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
    { buffer: captures[0]?.buffer, bytesPerRow, rowsPerImage: 2 },
    { width: 900, height: 2, depthOrArrayLayers: 1 },
  );
  expect(owner.stats.liveByteLength).toBe(bytesPerRow * 2);
  expect(owner.disposeObservationCaptures(captures)).toBeUndefined();
  expect(owner.stats.liveByteLength).toBe(0);
  device.destroyTexture(texture).unwrap();
});

it('uses the observed view extent rather than presentation dimensions for a reduced-resolution HDR source', async () => {
  const { addObservationCapturePass } = await import('../typed-render-graph-primitives');
  const { ok } = await import('@forgeax/engine-types');
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = device
    .createTexture({ size: { width: 16, height: 8 }, format: 'rgba16float', usage: 0x11 })
    .unwrap();
  const owner = createRendererObservationCaptureOwner((error) => {
    throw error;
  });
  let encode: ((...args: unknown[]) => void) | undefined;
  const graph = {
    addCopyPass: (_name: unknown, pass: { encodeDirect: (...args: unknown[]) => void }) => {
      encode = pass.encodeDirect;
      return ok(undefined);
    },
  };
  const frame = {
    targetW: 64,
    targetH: 64,
    runtime: {
      device,
      observationCaptureOwner: owner.observationCaptureOwner,
      observationCaptureDomains: ['linear-hdr'],
    },
    frameState: { frameNumber: 17, graphGeneration: 9, frameOutputs: {} },
  };
  addObservationCapturePass(
    graph as never,
    { texture: {}, view: {}, format: 'rgba16float', sampleCount: 1 } as never,
    'linear-hdr',
  );
  if (!encode) throw new Error('missing observation pass');
  const encoder = device.createCommandEncoder().unwrap(),
    copy = vi.spyOn(encoder, 'copyTextureToBuffer');
  encode(encoder, frame, {
    texture: () => ok(texture),
    textureViewExtent: () => ok({ width: 16, height: 8, depthOrArrayLayers: 1 }),
  });
  const captures = owner.observationCaptureOwner.consume(17);
  expect(captures[0]).toMatchObject({ width: 16, height: 8, bytesPerRow: 256 });
  expect(copy.mock.calls[0]?.[2]).toEqual({ width: 16, height: 8, depthOrArrayLayers: 1 });
  owner.disposeObservationCaptures(captures);
  device.destroyTexture(texture).unwrap();
});
