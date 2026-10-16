import {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
} from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { evaluateSurfaceOpticalViewDirection } from './surface-standard-pipeline.runtime-fixture';

describe('surface optical projection-aware view direction', () => {
  it('keeps orthographic rays parallel at off-axis surface positions', () => {
    const camera = [0, 0, 8] as const;
    const surfaceToCamera = [0, 0, 1] as const;
    const center = evaluateSurfaceOpticalViewDirection(
      CAMERA_PROJECTION_ORTHOGRAPHIC,
      [0, 0, 0],
      camera,
      surfaceToCamera,
    );
    const offAxis = evaluateSurfaceOpticalViewDirection(
      CAMERA_PROJECTION_ORTHOGRAPHIC,
      [2.4, -1.4, -0.25],
      camera,
      surfaceToCamera,
    );

    expect(center).toEqual([0, 0, 1]);
    expect(offAxis).toEqual(center);
  });

  it('keeps perspective rays position-dependent', () => {
    const camera = [0, 0, 8] as const;
    const center = evaluateSurfaceOpticalViewDirection(
      CAMERA_PROJECTION_PERSPECTIVE,
      [0, 0, 0],
      camera,
      [0, 0, 1],
    );
    const offAxis = evaluateSurfaceOpticalViewDirection(
      CAMERA_PROJECTION_PERSPECTIVE,
      [2.4, -1.4, -0.25],
      camera,
      [0, 0, 1],
    );

    expect(center).toEqual([0, 0, 1]);
    expect(offAxis).not.toEqual(center);
    expect(offAxis[0]).toBeLessThan(0);
    expect(offAxis[1]).toBeGreaterThan(0);
  });
});
