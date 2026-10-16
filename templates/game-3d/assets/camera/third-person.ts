export const LOOK_SENSITIVITY = 0.0022;
export const MIN_CAMERA_PITCH = (-10 * Math.PI) / 180;
export const MAX_CAMERA_PITCH = (65 * Math.PI) / 180;

export interface HorizontalAxes {
  readonly forwardX: number;
  readonly forwardZ: number;
  readonly rightX: number;
  readonly rightZ: number;
}

export interface HorizontalMove {
  readonly x: number;
  readonly z: number;
  readonly length: number;
}

/**
 * ForgeaX uses a right-handed world: +Y is up. This template defines yaw=0
 * as looking toward world -Z, so camera-right is +X. Mouse X changes yaw;
 * WASD is projected onto these horizontal camera axes; character facing then
 * follows the resolved move vector. Pitch only changes the camera orbit.
 * Screen Y grows downward, so mouse-down raises orbit pitch and looks down.
 */
export function horizontalCameraAxes(yaw: number): HorizontalAxes {
  return {
    forwardX: Math.sin(yaw),
    forwardZ: -Math.cos(yaw),
    rightX: Math.cos(yaw),
    rightZ: Math.sin(yaw),
  };
}

export function cameraRelativeMove(yaw: number, horizontal: number, vertical: number): HorizontalMove {
  const axes = horizontalCameraAxes(yaw);
  let x = axes.forwardX * vertical + axes.rightX * horizontal;
  let z = axes.forwardZ * vertical + axes.rightZ * horizontal;
  const length = Math.hypot(x, z);
  if (length > 1) {
    x /= length;
    z /= length;
  }
  return { x, z, length: Math.min(1, length) };
}

/** Transform rotation around +Y that makes authored forward (-Z) face movement. */
export function facingYaw(moveX: number, moveZ: number): number {
  return Math.atan2(-moveX, -moveZ);
}

export function integratePointerLook(
  yaw: number,
  pitch: number,
  movementX: number,
  movementY: number,
): { readonly yaw: number; readonly pitch: number } {
  return {
    yaw: yaw + movementX * LOOK_SENSITIVITY,
    pitch: Math.max(
      MIN_CAMERA_PITCH,
      Math.min(MAX_CAMERA_PITCH, pitch + movementY * LOOK_SENSITIVITY),
    ),
  };
}

export function orbitPosition(
  target: readonly [number, number, number],
  yaw: number,
  pitch: number,
  distance: number,
): readonly [number, number, number] {
  const horizontal = Math.cos(pitch) * distance;
  return [
    target[0] - Math.sin(yaw) * horizontal,
    target[1] + Math.sin(pitch) * distance,
    target[2] + Math.cos(yaw) * horizontal,
  ];
}
