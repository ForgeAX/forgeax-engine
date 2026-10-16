import { describe, expect, it } from 'vitest';
import { makeRhiDevice } from '../device';

function makeStructuralRawDevice(): unknown {
  return {
    features: new Set<string>(),
    limits: {},
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
      writeTexture: () => undefined,
      copyExternalImageToTexture: () => undefined,
      onSubmittedWorkDone: () => Promise.resolve(),
    },
    lost: Promise.resolve({ reason: 'unknown', message: '' }),
  };
}

describe('wgpu r32float profile matrix', () => {
  it('returns closed unavailable evidence for the CPU/WebGL2 lane', async () => {
    const device = makeRhiDevice(makeStructuralRawDevice() as never).device;
    const result = await device.probeTextureFormatCapability();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rhi-texture-format-capability-unavailable');
      expect(result.error.detail).toMatchObject({ stage: 'texture-create' });
    }
  });
});
