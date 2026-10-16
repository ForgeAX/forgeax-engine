import type { EntityHandle } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { type VolumetricFogAuthoring, validateVolumetricFog } from '../volume/component';

const density = {
  guid: 'density-guid',
  generation: 3,
  shape: { viewDimension: '3d', extent: { width: 64, height: 64, depth: 64 } },
  format: 'r8unorm',
} as const;

const validFog: VolumetricFogAuthoring = {
  light: 1 as EntityHandle,
  density,
  bounds: { min: [-4, -2, -8], max: [4, 6, 8] },
  extinction: [0.7, 0.8, 0.9],
  albedo: [0.9, 0.92, 1],
  emission: [0, 0, 0],
  anisotropy: 0.2,
  maxDistance: 80,
};

describe('VolumetricFog authoring contract', () => {
  it('accepts one linear 3D density owner without ECS quality facts', () => {
    const result = validateVolumetricFog(validFog);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.density.guid).toBe('density-guid');
      expect(result.value.density.generation).toBe(3);
      expect(result.value).not.toHaveProperty('quality');
      expect(result.value).not.toHaveProperty('grid');
    }
  });

  it('rejects a 2D or array density view dimension', () => {
    for (const viewDimension of ['2d', '2d-array'] as const) {
      const result = validateVolumetricFog({
        ...validFog,
        density: { ...density, shape: { viewDimension, extent: { width: 64, height: 64 } } },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('volume-density-shape-mismatch');
    }
  });

  it('rejects negative extinction, invalid anisotropy, and non-positive distance', () => {
    const invalidInputs: VolumetricFogAuthoring[] = [
      { ...validFog, extinction: [-0.1, 0, 0] },
      { ...validFog, anisotropy: 1 },
      { ...validFog, maxDistance: 0 },
    ];
    for (const input of invalidInputs) {
      const result = validateVolumetricFog(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('volume-invalid-parameters');
    }
  });

  it('rejects inverted, degenerate, and non-finite bounds', () => {
    const invalidBounds = [
      { min: [4, -2, -8], max: [-4, 6, 8] },
      { min: [0, 0, 0], max: [0, 1, 1] },
      { min: [Number.NaN, 0, 0], max: [1, 1, 1] },
    ] as const;
    for (const bounds of invalidBounds) {
      const result = validateVolumetricFog({ ...validFog, bounds });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('volume-invalid-bounds');
    }
  });

  it.each([
    'rgba8unorm',
    'rgba16float',
  ])('accepts a linear %s density and albedo field', (format) => {
    const input: VolumetricFogAuthoring = {
      ...validFog,
      density: { ...density, format },
      sampling: 'density-albedo',
    };
    expect(validateVolumetricFog(input)).toEqual({ ok: true, value: input });
  });

  it.each([
    'r8unorm',
    'rg8unorm',
    'rgba32float',
    'rgba8unorm-srgb',
  ])('rejects %s instead of inventing missing or unfilterable optical channels', (format) => {
    const result = validateVolumetricFog({
      ...validFog,
      density: { ...density, format },
      sampling: 'density-albedo',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('volume-invalid-parameters');
      expect(result.error.detail).toEqual({ field: 'density.format', value: format });
    }
  });
});
