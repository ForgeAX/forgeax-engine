import type { RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { createAutoExposureGpuResources } from '../gpu';

function deviceWith(caps: { compute: boolean; storageBuffer: boolean }): RhiDevice {
  return { caps } as unknown as RhiDevice;
}

describe('auto exposure capability gate', () => {
  it('names the first missing live capability with the requesting generation', () => {
    expect(
      createAutoExposureGpuResources(deviceWith({ compute: false, storageBuffer: true }), 8),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'auto-exposure-capability-unavailable',
        detail: { capability: 'compute', generation: 8 },
      },
    });
    expect(
      createAutoExposureGpuResources(deviceWith({ compute: true, storageBuffer: false }), 9),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'auto-exposure-capability-unavailable',
        detail: { capability: 'storage-buffer', generation: 9 },
      },
    });
  });
});
