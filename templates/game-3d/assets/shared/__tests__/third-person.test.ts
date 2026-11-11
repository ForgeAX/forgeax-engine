import { describe, expect, it } from 'vitest';
import {
  MAX_CAMERA_PITCH,
  MIN_CAMERA_PITCH,
  cameraRelativeMove,
  facingYaw,
  horizontalCameraAxes,
  integratePointerLook,
} from '../third-person.ts';

describe('third-person camera math', () => {
  it('defines camera-relative directions without left/right or front/back ambiguity', () => {
    expect(horizontalCameraAxes(0)).toEqual({ forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0 });
    const left = cameraRelativeMove(0, -1, 0);
    const right = cameraRelativeMove(0, 1, 0);
    expect(left.x).toBe(-1);
    expect(left.z).toBeCloseTo(0);
    expect(right.x).toBe(1);
    expect(right.z).toBeCloseTo(0);
    const quarterTurn = cameraRelativeMove(Math.PI / 2, 0, 1);
    expect(quarterTurn.x).toBeCloseTo(1);
    expect(quarterTurn.z).toBeCloseTo(0);
    expect(facingYaw(0, -1)).toBeCloseTo(0);
    expect(facingYaw(1, 0)).toBeCloseTo(-Math.PI / 2);
  });

  it('uses locked-pointer deltas with a bounded camera pitch', () => {
    expect(integratePointerLook(0, 0, 100, 0).yaw).toBeGreaterThan(0);
    expect(integratePointerLook(0, 0, 0, -100_000).pitch).toBe(MIN_CAMERA_PITCH);
    expect(integratePointerLook(0, 0, 0, 100_000).pitch).toBe(MAX_CAMERA_PITCH);
  });
});
