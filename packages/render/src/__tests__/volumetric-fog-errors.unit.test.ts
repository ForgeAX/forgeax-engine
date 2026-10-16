import type { EntityHandle } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { type VolumetricFogAuthoring, validateVolumetricFog } from '../volume/component';
import { extractVolumetricFog } from '../volume/extract';

const base: VolumetricFogAuthoring = {
  light: 1 as EntityHandle,
  density: {
    guid: 'density-guid',
    generation: 1,
    shape: { viewDimension: '3d', extent: { width: 32, height: 32, depth: 32 } },
    format: 'r16float',
  },
  bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  extinction: [1, 1, 1],
  albedo: [1, 1, 1],
  emission: [0, 0, 0],
  anisotropy: 0,
  maxDistance: 10,
};

describe('VolumetricFog structured error contract', () => {
  it('exposes code, expected, hint, and detail for every validation failure', () => {
    const result = validateVolumetricFog({ ...base, maxDistance: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'volume-invalid-parameters',
        expected: expect.any(String),
        hint: expect.any(String),
        detail: expect.objectContaining({ field: 'maxDistance' }),
      });
    }
  });

  it('keeps volume budget overflow as a closed error', () => {
    const result = extractVolumetricFog(Array.from({ length: 12 }, () => base));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('volume-owner-conflict');
      expect(result.error.detail).toMatchObject({ ownerCount: 12 });
    }
  });

  it('preserves density identity and generation in the success projection', () => {
    const result = validateVolumetricFog(base);
    expect(result).toMatchObject({
      ok: true,
      value: { density: { guid: 'density-guid', generation: 1 } },
    });
  });
});
