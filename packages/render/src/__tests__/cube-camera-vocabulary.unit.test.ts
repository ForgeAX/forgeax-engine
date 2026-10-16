import { describe, expect, it } from 'vitest';
import {
  CUBE_CAMERA_FACE_ORDER,
  CUBE_CAMERA_UPDATE_CONTINUOUS,
  CUBE_CAMERA_UPDATE_ON_DEMAND,
  CUBE_CAMERA_UPDATE_ONCE,
  CubeCamera,
  cubeCameraUpdateIntentFromF32,
} from '../components/cube-camera';
import { RenderIntentInvalidError } from '../errors/render';

describe('CubeCamera vocabulary', () => {
  it('exposes the canonical faces and bounded capture facts', () => {
    expect(CUBE_CAMERA_FACE_ORDER).toEqual(['+X', '-X', '+Y', '-Y', '+Z', '-Z']);
    expect(CubeCamera.fields.target.type).toBe('shared<RenderTarget>');
    expect(CubeCamera.fields.near.type).toBe('f32');
    expect(CubeCamera.fields.far.type).toBe('f32');
    expect(CubeCamera.fields.requestVersion.type).toBe('u32');
    expect(CubeCamera.fields.faceBudget.type).toBe('u32');
    expect(CubeCamera.fields.updateIntent.type).toBe('f32');
  });

  it('keeps update intent closed and decodable', () => {
    expect(cubeCameraUpdateIntentFromF32(CUBE_CAMERA_UPDATE_ONCE)).toBe('once');
    expect(cubeCameraUpdateIntentFromF32(CUBE_CAMERA_UPDATE_ON_DEMAND)).toBe('on-demand');
    expect(cubeCameraUpdateIntentFromF32(CUBE_CAMERA_UPDATE_CONTINUOUS)).toBe('continuous');
  });

  it('reports invalid update intent through the structured render error contract', () => {
    expect(() => cubeCameraUpdateIntentFromF32(99)).toThrowError(RenderIntentInvalidError);
    try {
      cubeCameraUpdateIntentFromF32(99);
    } catch (error) {
      expect(error).toBeInstanceOf(RenderIntentInvalidError);
      if (!(error instanceof RenderIntentInvalidError)) return;
      expect(error.code).toBe('render-intent-invalid');
      expect(error.expected).toBe('CubeCamera.updateIntent is one of 0, 1, or 2');
      expect(error.hint).toBe('set CubeCamera.updateIntent to 0, 1, or 2');
      expect(error.detail).toEqual({
        component: 'CubeCamera',
        field: 'updateIntent',
        value: 99,
        allowed: [0, 1, 2],
      });
    }
  });
});
