import { describe, expect, it } from 'vitest';
import { createExtendedLightingCarrierSurface } from '../extended-case-carrier';

describe('extended-lighting carrier surface', () => {
  it('mirrors the renderer canvas descriptor instead of assuming RGBA', () => {
    const descriptors: Record<string, unknown>[] = [];
    const texture = { destroy: () => undefined };
    const device = {
      createTexture(descriptor: Record<string, unknown>) {
        descriptors.push(descriptor);
        return texture;
      },
    } as unknown as GPUDevice;
    const surface = createExtendedLightingCarrierSurface(64, 64);
    const context = surface.canvas.getContext('webgpu') as unknown as {
      configure(descriptor: {
        device: GPUDevice;
        format: GPUTextureFormat;
        usage: number;
        viewFormats: readonly GPUTextureFormat[];
      }): void;
    };

    context.configure({
      device,
      format: 'bgra8unorm',
      usage: 0x15,
      viewFormats: ['bgra8unorm-srgb'],
    });

    expect(descriptors).toEqual([
      {
        size: { width: 64, height: 64, depthOrArrayLayers: 1 },
        format: 'bgra8unorm',
        usage: 0x15,
        viewFormats: ['bgra8unorm-srgb'],
      },
    ]);
  });
});
