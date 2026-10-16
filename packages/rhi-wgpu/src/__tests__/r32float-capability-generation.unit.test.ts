import { describe, expect, it } from 'vitest';
import { makeRhiDevice } from '../device';

function rawDevice(): unknown {
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

describe('wgpu r32float probe generation budget', () => {
  it('reuses one unavailable probe and invalidates it on replacement', async () => {
    const first = makeRhiDevice(rawDevice() as never).device;
    const firstProbe = first.probeTextureFormatCapability();
    expect(first.probeTextureFormatCapability()).toBe(firstProbe);
    const firstResult = await firstProbe;
    expect(firstResult.ok).toBe(false);
    if (firstResult.ok) return;

    const replacement = makeRhiDevice(rawDevice() as never).device;
    const replacementResult = await replacement.probeTextureFormatCapability();
    expect(replacementResult.ok).toBe(false);
    if (replacementResult.ok) return;
    expect(replacementResult.error.detail).toMatchObject({
      stage: 'texture-create',
    });
    expect(replacementResult.error.detail).not.toBe(firstResult.error.detail);
  });
});
