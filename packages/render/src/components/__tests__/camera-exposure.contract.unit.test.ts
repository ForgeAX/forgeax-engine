import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { extractCameraSnapshots } from '../../render-system-extract';
import {
  CAMERA_EXPOSURE_MODE_AUTO,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  CameraError,
  type CameraExposure,
  cameraExposureFromColumns,
  orthographic,
  perspective,
  validateCameraColorGrading,
  validateCameraExposure,
} from '../index';

function describeExposure(exposure: CameraExposure): string {
  switch (exposure.kind) {
    case 'manual':
      return `manual:${exposure.multiplier}`;
    case 'auto':
      return `auto:${exposure.fallback}`;
  }
  const unreachable: never = exposure;
  return unreachable;
}

describe('CameraExposure contract', () => {
  it('keeps manual, auto, and defaults in the Camera schema', () => {
    expect(Camera.fields.exposureMode.default).toBe(CAMERA_EXPOSURE_MODE_MANUAL);
    expect(Camera.fields.exposure.default).toBe(1);
    expect(Camera.fields.rangeEv.default).toEqual(new Float32Array([-8, 8]));
    expect(Camera.fields.rates.default).toEqual(new Float32Array([3, 1]));
    expect(Camera.fields.temperature.default).toBe(6504);
    expect(Camera.fields.tint.default).toBe(0);
    expect(Camera.fields.colorLut.type).toBe('shared<TextureAsset>');
    expect(Camera.fields.colorLutStrength.default).toBe(0);
  });

  it('projects the same public output through both camera factories', () => {
    const exposure: CameraExposure = {
      kind: 'auto',
      fallback: 1.25,
      compensationEv: -0.5,
      rangeEv: [-6, 6],
      rates: [3, 1],
    };
    const perspectiveCamera = perspective({
      fov: Math.PI / 3,
      aspect: 16 / 9,
      exposure,
      temperature: 5000,
      tint: 0.1,
      colorLutStrength: 0.5,
    });
    const orthographicCamera = orthographic({
      left: -10,
      right: 10,
      bottom: -10,
      top: 10,
      exposure,
      temperature: 5000,
      tint: 0.1,
      colorLutStrength: 0.5,
    });
    expect(perspectiveCamera.exposureMode).toBe(CAMERA_EXPOSURE_MODE_AUTO);
    expect(orthographicCamera.exposureMode).toBe(CAMERA_EXPOSURE_MODE_AUTO);
    expect(perspectiveCamera.exposure).toBe(1.25);
    expect(orthographicCamera.rangeEv).toEqual(new Float32Array([-6, 6]));
    expect(describeExposure(cameraExposureFromColumns(perspectiveCamera))).toBe('auto:1.25');
  });

  it('rejects non-finite, reversed, and negative-rate authoring', () => {
    expect(() => validateCameraExposure({ kind: 'manual', multiplier: 0 })).toThrow(CameraError);
    try {
      validateCameraExposure({ kind: 'manual', multiplier: 0 });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'camera-exposure-invalid',
        expected: 'a finite number greater than zero',
        detail: { field: 'multiplier', actual: 0 },
      });
    }
    expect(() =>
      validateCameraExposure({
        kind: 'auto',
        fallback: Number.NaN,
        compensationEv: 0,
        rangeEv: [-8, 8],
        rates: [3, 1],
      }),
    ).toThrow();
    expect(() =>
      validateCameraExposure({
        kind: 'auto',
        fallback: 1,
        compensationEv: 0,
        rangeEv: [8, -8],
        rates: [3, 1],
      }),
    ).toThrow();
    expect(() =>
      validateCameraExposure({
        kind: 'auto',
        fallback: 1,
        compensationEv: 0,
        rangeEv: [-8, 8],
        rates: [-1, 1],
      }),
    ).toThrow();
  });

  it('reports closed structured failures for Camera color fields and column modes', () => {
    expect(() => validateCameraExposure({ kind: 'manual', multiplier: Number.NaN })).toThrow(
      CameraError,
    );
    expect(() => validateCameraColorGrading(500, 0, 0)).toThrow(CameraError);
    expect(() => validateCameraColorGrading(6504, 2, 0)).toThrow(CameraError);
    expect(() =>
      cameraExposureFromColumns({
        exposureMode: 7,
        exposure: 1,
        compensationEv: 0,
        rangeEv: new Float32Array([-8, 8]),
        rates: new Float32Array([3, 1]),
      }),
    ).toThrow(CameraError);
  });

  it('closes the Camera -> SoA extract identity for perspective and orthographic', () => {
    const world = new World();
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: Camera,
          data: perspective({
            fov: Math.PI / 3,
            aspect: 1,
            exposure: { kind: 'manual', multiplier: 2 },
          }),
        },
      )
      .unwrap();
    const [snapshot] = extractCameraSnapshots(world);
    expect(snapshot?.output?.exposure).toEqual({ kind: 'manual', multiplier: 2 });
    expect(snapshot?.output?.temperature).toBe(6504);
    expect(snapshot?.output?.tint).toBe(0);
    expect(snapshot?.output?.colorLutStrength).toBe(0);
    expect(snapshot?.projection).toBe('perspective');
  });
});
