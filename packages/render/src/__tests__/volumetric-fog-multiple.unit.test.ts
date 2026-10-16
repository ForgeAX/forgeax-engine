import type { EntityHandle } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import type { VolumetricFogAuthoring } from '../volume/component';
import { extractVolumetricFog } from '../volume/extract';

const fog: VolumetricFogAuthoring = {
  light: 0 as EntityHandle,
  density: {
    guid: 'smoke-a',
    generation: 1,
    format: 'r8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '3d', extent: { width: 16, height: 16, depth: 16 } },
  },
  bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  extinction: [1, 1, 1],
  albedo: [0.8, 0.8, 0.8],
  emission: [0, 0, 0],
  anisotropy: 0,
  maxDistance: 20,
};

describe('independent local volumetric fog owners', () => {
  it('accepts overlapping owners and retains their distinct optical properties', () => {
    const second = { ...fog, emission: [1, 0, 0] as const };
    const result = extractVolumetricFog([fog, second]);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.status === 'available') {
      expect(result.value.fogs).toHaveLength(2);
      expect(result.value.fogs[1]?.emission).toEqual([1, 0, 0]);
    }
  });
  it('validates every owner, not only the first', () => {
    const result = extractVolumetricFog([fog, { ...fog, anisotropy: 2 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('volume-invalid-parameters');
  });
  it.each([
    9, 11,
  ])('admits %i independently placed density fields without changing their sampling or optics', (count) => {
    const fields = Array.from({ length: count }, (_, index) => ({
      ...fog,
      density: { ...fog.density, guid: `density-${index}`, generation: index + 1 },
      bounds: { min: [index * 0.175, 0, 0] as const, max: [index * 0.175 + 1, 1, 1] as const },
      extinction: [index + 1, 2, 3] as const,
      emission: [index / 9, 0, 0] as const,
      sampling: 'density' as const,
    }));
    const result = extractVolumetricFog(fields).unwrap();
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.fogs).toEqual(fields);
      for (const [index, field] of fields.entries()) expect(result.fogs[index]).toBe(field);
    }
  });
  it('removes one owner independently and turns off only after the last', () => {
    const result = extractVolumetricFog([fog]);
    expect(result.ok && result.value.status === 'available' && result.value.fogs.length).toBe(1);
    expect(extractVolumetricFog([])).toEqual({ ok: true, value: { status: 'off' } });
  });
  it('rejects overflow explicitly instead of dropping visible owners', () => {
    const result = extractVolumetricFog(Array.from({ length: 12 }, () => fog));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('volume-owner-conflict');
  });
  it('rejects unknown sampling modes in untyped input', () => {
    const result = extractVolumetricFog([
      { ...fog, sampling: 'unknown' } as unknown as VolumetricFogAuthoring,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('volume-invalid-parameters');
  });
});
