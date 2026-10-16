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
