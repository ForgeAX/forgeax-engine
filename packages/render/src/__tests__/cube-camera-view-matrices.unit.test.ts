import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { buildCubeCameraFaceViews } from '../capture/cube-views';
import { CUBE_CAMERA_FACE_ORDER } from '../components/cube-camera';

describe('CubeCamera canonical view matrices', () => {
  it('builds six ordered views from one origin with shared near/far', () => {
    const views = buildCubeCameraFaceViews({
      position: [2, 3, 4],
      near: 0.25,
      far: 80,
    });

    expect(views.map((view) => view.face)).toEqual(CUBE_CAMERA_FACE_ORDER);
    expect(views).toHaveLength(6);
    expect(views.every((view) => view.near === 0.25 && view.far === 80)).toBe(true);
    expect(
      views.every((view) => view.view.length === 16 && view.viewProjection.length === 16),
    ).toBe(true);
    expect(new Set(views.map((view) => Array.from(view.view))).size).toBe(6);
  });

  it('keeps asymmetric world directions in the canonical cube face orientation', () => {
    const views = buildCubeCameraFaceViews({ position: [0, 0, 0], near: 0.1, far: 10 });
    const samples = [
      { direction: [1, 0.25, -0.4], ndc: [-0.4, 0.25] },
      { direction: [-1, 0.25, 0.4], ndc: [-0.4, 0.25] },
      { direction: [0.35, 1, 0.25], ndc: [-0.35, -0.25] },
      { direction: [0.35, -1, -0.25], ndc: [-0.35, -0.25] },
      { direction: [0.35, 0.25, 1], ndc: [-0.35, 0.25] },
      { direction: [-0.35, 0.25, -1], ndc: [-0.35, 0.25] },
    ] as const;

    for (const [index, sample] of samples.entries()) {
      const ndc = vec3.create();
      mat4.transformVec3(ndc, views[index]?.viewProjection ?? mat4.create(), sample.direction);
      expect(ndc[0]).toBeCloseTo(sample.ndc[0], 5);
      expect(ndc[1]).toBeCloseTo(sample.ndc[1], 5);
    }
  });
});
