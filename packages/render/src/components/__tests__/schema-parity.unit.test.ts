import { describe, expect, it } from 'vitest';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  orthographic,
  perspective,
} from '../index';

describe('render schema parity', () => {
  it('keeps branded mesh and merged light fields in the canonical schema', () => {
    expect(MeshFilter.fields.assetHandle.type).toBe('asset<mesh>');
    expect(DirectionalLight.fields.direction.type).toBe('array<f32, 3>');
    expect(DirectionalLight.fields.castShadow.default).toBe(false);
    expect(DirectionalLight.fields.shadowFilter.labels).toEqual({
      pcf1: 1,
      pcf3: 2,
      pcf5: 3,
      pcssMedium: 4,
      pcssHigh: 5,
      pcfVogel: 6,
      pcfSoft: 7,
      variance: 8,
    });
    expect(DirectionalLight.fields.shadowFilter.default).toBe(6);
    expect('pcfKernelSize' in DirectionalLight.fields).toBe(false);
    expect(MeshRenderer.fields.materials.type).toBe('array<asset<material>>');
  });

  it('exposes both camera projection variants and helpers', () => {
    expect(Camera.fields.projection.default).toBe(0);
    expect(Camera.fields.left.default).toBe(-1);
    expect(perspective({ fov: 1, aspect: 2 }).projection).toBe(0);
    expect(orthographic({ left: -2, right: 2, bottom: -1, top: 1 }).projection).toBe(1);
  });
});
