import type { RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { rhi } from '../index';

async function requestDevice(): Promise<RhiDevice | undefined> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) {
    expect(adapter.error.code).toBe('rhi-not-available');
    return undefined;
  }
  const device = await adapter.value.requestDevice();
  expect(device.ok).toBe(true);
  return device.ok ? device.value : undefined;
}

describe('rhi-wgpu Dawn texture dimensions', () => {
  it('reports an unavailable Dawn adapter as structured status', async () => {
    const device = await requestDevice();
    if (device === undefined) return;

    const arrayTexture = device.createTexture({
      label: 'dawn-array-texture',
      size: { width: 2, height: 2, depthOrArrayLayers: 3 },
      dimension: '2d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    expect(arrayTexture.ok).toBe(true);
    if (!arrayTexture.ok) return;
    expect(device.createTextureView(arrayTexture.value, { dimension: '2d-array' }).ok).toBe(true);

    const volumeTexture = device.createTexture({
      label: 'dawn-volume-texture',
      size: { width: 2, height: 2, depthOrArrayLayers: 3 },
      dimension: '3d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    expect(volumeTexture.ok).toBe(true);
    if (!volumeTexture.ok) return;
    expect(device.createTextureView(volumeTexture.value, { dimension: '3d' }).ok).toBe(true);
  });
});
