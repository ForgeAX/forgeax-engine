import { describe, expect, it } from 'vitest';
import { CUBE_CAMERA_FACE_ORDER } from '@forgeax/engine-render';
import { buildCubeCameraFaceViews } from '@forgeax/engine-render';

describe('CubeCamera Browser WebGPU orientation evidence', () => {
  it('matches the CPU oracle for all six ordered faces', () => {
    const views = buildCubeCameraFaceViews({ position: [0, 0, 0], near: 0.1, far: 10 });
    expect(views.map((view) => view.face)).toEqual(CUBE_CAMERA_FACE_ORDER);
    expect(views.map((view) => view.direction)).toEqual([
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]);
    expect(views.every((view) => view.near === 0.1 && view.far === 10)).toBe(true);
  });
});
