import { describe, expect, it, vi } from 'vitest';
import { disposeDevice, makeRhiDevice } from '../device';

describe('backend device retirement', () => {
  it('destroys an acquired native GPUDevice exactly once', () => {
    const destroy = vi.fn();
    const raw = {
      features: new Set<string>(),
      limits: {
        maxStorageBuffersPerShaderStage: 8,
        maxStorageTexturesPerShaderStage: 4,
        maxColorAttachments: 8,
      },
      queue: {},
      lost: new Promise<GPUDeviceLostInfo>(() => {}),
      createTexture: () => ({ destroy: vi.fn() }),
      destroy,
    } as unknown as GPUDevice;
    const { device } = makeRhiDevice(raw);

    disposeDevice(device);
    disposeDevice(device);

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
