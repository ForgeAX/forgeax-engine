export const degrees = Math.PI / 180;

// Frozen Simulation Blank camera, UE centimeters. UE (+X forward, +Y right,
// +Z up) to ForgeaX (+X right, +Y up, -Z forward); measured floor top is UE Z=-0.5 cm.
export const REFERENCE_EYE = [157.17355489, 0.35069365, 36.17745191] as const;
export const REFERENCE_YAW = 121.540557 * degrees;
export const REFERENCE_PITCH = 11.521956 * degrees;
// UE authors the 90-degree horizontal FOV in a 4:3 view and maintains its
// derived vertical FOV when the runtime viewport aspect changes.
const UE_HORIZONTAL_FOV = 90 * degrees;
const UE_VIEW_ASPECT = 4 / 3;
export const REFERENCE_VERTICAL_FOV = 2 * Math.atan(Math.tan(UE_HORIZONTAL_FOV / 2) / UE_VIEW_ASPECT);

export interface GroundCamera {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export function referenceCamera(): GroundCamera {
  return { x: REFERENCE_EYE[0], y: REFERENCE_EYE[1], z: REFERENCE_EYE[2], yaw: REFERENCE_YAW, pitch: REFERENCE_PITCH };
}

export function shadowInspectionCamera(): GroundCamera {
  return { x: 0, y: 2000, z: 3600, yaw: 0, pitch: -40 * degrees };
}

export function groundShadowCamera(): GroundCamera {
  return { x: 0, y: 20, z: 600, yaw: 180 * degrees, pitch: -10 * degrees };
}

export function viewDirection(yaw: number, pitch: number): [number, number, number] {
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}

export function stepGroundCamera(
  camera: GroundCamera,
  right: number,
  forward: number,
  turn: number,
  tilt: number,
  seconds: number,
): void {
  camera.yaw = (camera.yaw + turn) % (2 * Math.PI);
  camera.pitch = Math.max((camera.y > 100 ? -85 : -20) * degrees, Math.min(80 * degrees, camera.pitch + tilt));
  const distance = (camera.y > 100 ? 300 : 3) * seconds / Math.max(1, Math.hypot(right, forward));
  const sin = Math.sin(camera.yaw);
  const cos = Math.cos(camera.yaw);
  camera.x += (right * cos + forward * sin) * distance;
  camera.z += (right * sin - forward * cos) * distance;
}

// Center of the switchable depth fixture, forward and slightly left of the
// reference camera. It crosses the horizon without covering the center.
const forward = viewDirection(REFERENCE_YAW, 0);
export const OCCLUDER_CENTER = [
  REFERENCE_EYE[0] + 5.5 * forward[0] - 1.4 * Math.cos(REFERENCE_YAW),
  0.95,
  REFERENCE_EYE[2] + 5.5 * forward[2] - 1.4 * Math.sin(REFERENCE_YAW),
] as const;

// Runtime daylight probe (15:00 solar time), mapped from UE component
// forward to the ForgeaX outgoing light direction: (X, Y, Z) -> (Y, Z, -X).
export const SUN_DIRECTION = [-0.5798598423334443, -0.5965986238210013, -0.5548266804182369] as const;
