import { describe, expect, it } from 'vitest';
import { ANTIALIAS_TAA, Atmosphere, Camera, DirectionalLight, Fog, MeshFilter } from '../index';

describe('canonical render schema owners', () => {
  it('keeps mesh, light, and camera facts on their component owners', () => {
    expect(MeshFilter.fields.assetHandle.type).toBe('shared<MeshAsset>');
    expect(DirectionalLight.fields.direction.type).toBe('array<f32, 3>');
    expect(DirectionalLight.fields.shadowFilter.type).toBe('enum');
    expect(DirectionalLight.fields.shadowFilter.default).toBe(6);
    expect(DirectionalLight.fields.shadowFilter.labels).toEqual({
      pcf1: 1,
      pcf3: 2,
      pcf5: 3,
      pcssMedium: 4,
      pcssHigh: 5,
      pcfVogel: 6,
    });
    expect(DirectionalLight.fields.shadowAngularRadius.default).toBeCloseTo(0.00465, 8);
    expect(DirectionalLight.fields.maxPenumbraTexels.default).toBe(32);
    expect('pcfKernelSize' in DirectionalLight.fields).toBe(false);
    expect(Camera.fields.projection.default).toBe(0);
    expect(Camera.fields.antialias.default).toBe(0);
    expect(Camera.fields.historyVersion.default).toBe(0);
    expect(ANTIALIAS_TAA).toBe(3);
    expect(Atmosphere.fields.planetRadius.type).toBe('f32');
    expect(Fog.fields.density.type).toBe('f32');
  });
});
