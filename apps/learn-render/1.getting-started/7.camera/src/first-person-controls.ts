// first-person-controls.ts -- pure helpers exposing the LO §1.7 demo's
// dt-driven WASD displacement + scroll-wheel FoV accumulator as
// dependency-free functions so the unit tests (camera-dt-equivalence
// .test.ts + camera-fov-zoom.test.ts) can assert math without booting a
// renderer / canvas / WebGPU. The system fn bodies in index.ts call
// these helpers each tick; the renderer reads the mutated Transform +
// Camera SoA columns and the engine-internal mat4 composer turns them
// into GPU uniforms.
//
// Charter P5 producer / consumer split: helpers produce numbers; the
// system fns consume them to write component columns; the engine
// RenderSystem consumes the columns to compose view + projection.
//
// LO §1.7.2 verbatim (camera_keyboard_dt.cpp ProcessKeyboard):
//   float cameraSpeed = static_cast<float>(2.5 * deltaTime);
//   if (key == FORWARD)  position += cameraSpeed * Front;
//   if (key == BACKWARD) position -= cameraSpeed * Front;
//   if (key == LEFT)     position -= Right * cameraSpeed;
//   if (key == RIGHT)    position += Right * cameraSpeed;
//
// LO §1.7.3 verbatim (camera_mouse_zoom.cpp ProcessMouseScroll):
//   Zoom -= (float)yoffset;
//   if (Zoom < 1.0f)   Zoom = 1.0f;
//   if (Zoom > 45.0f)  Zoom = 45.0f;
//
// forgeax mapping (plan-strategy D-1 + D-4 + D-5):
//   - dt SSOT      = engine-app `Time` resource (frame-loop SSOT); the
//                    demo reads `world.getResource<TimeResource>('Time
//                    ').dt` per tick (no fn-callback signature change;
//                    OOS-6 honoured).
//   - cameraSpeed  = LO numeric SSOT 2.5 (world units per second).
//   - wheelDelta   = sign-discrete per-frame notch (engine-input D-5
//                    deltaMode normalisation; +1 = scroll up = fov
//                    decrease; -1 = scroll down = fov increase).
//   - Camera.fov   = field unit RADIANS (D-4: forgeax engine SSOT does
//                    not adopt LO degree-axis literal; degree-form
//                    `fovDeg` lives in this helper as the LO-numeric
//                    teaching surface and is converted to radians on
//                    write).

export const CAMERA_SPEED_PER_SECOND = 2.5;
export const FOV_MIN_DEG = 1;
export const FOV_MAX_DEG = 45;
export const FOV_INITIAL_DEG = 45;

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface WasdHeld {
  readonly w: boolean;
  readonly s: boolean;
  readonly a: boolean;
  readonly d: boolean;
}

export interface DisplacementXYZ {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Compute the LO §1.7.2 per-frame WASD displacement.
 *
 * Pure function: no allocations beyond the returned POD; no engine /
 * world / renderer references. The demo system fn integrates the
 * returned vector into the camera Transform's pos lanes each tick.
 *
 * @param dt seconds elapsed since previous tick (Time resource SSOT).
 * @param forward unit forward direction reconstructed from yaw/pitch.
 * @param right unit right direction (cross(forward, world-up)).
 * @param held WASD held-key state (snapshot.keyboard.down('w'/'a'/'s'/'d')).
 */
export function computeWasdDisplacement(
  dt: number,
  forward: Vec3Like,
  right: Vec3Like,
  held: WasdHeld,
): DisplacementXYZ {
  const speed = CAMERA_SPEED_PER_SECOND * dt;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  if (held.w) {
    dx += forward.x * speed;
    dy += forward.y * speed;
    dz += forward.z * speed;
  }
  if (held.s) {
    dx -= forward.x * speed;
    dy -= forward.y * speed;
    dz -= forward.z * speed;
  }
  if (held.a) {
    dx -= right.x * speed;
    dz -= right.z * speed;
  }
  if (held.d) {
    dx += right.x * speed;
    dz += right.z * speed;
  }
  return { x: dx, y: dy, z: dz };
}

export interface ScrollFovAccumulator {
  /** Current FoV in degrees (LO teaching unit). */
  readonly fovDeg: number;
  /** Current FoV in radians (forgeax Camera.fov field unit, D-4). */
  readonly fovRad: number;
  /**
   * Apply one frame's wheelDelta (sign-discrete notch, engine-input D-5).
   * Mutates the accumulator in place; LO sign convention `fov -= wheelDelta`
   * (scroll up notch = +1 wheelDelta = fov decrease).
   */
  apply(wheelDelta: number): void;
}

/**
 * Create a closure-scoped scroll-wheel FoV accumulator (LO §1.7.3).
 *
 * Initial state: 45 deg (LO default); clamps within [1, 45] deg per
 * LO chapter; exposes both degree (LO teaching unit) and radian
 * (forgeax Camera.fov field unit, plan-strategy D-4) views so the
 * system fn can write the radian form directly.
 */
export function createScrollFovAccumulator(): ScrollFovAccumulator {
  let fovDeg = FOV_INITIAL_DEG;
  const acc: ScrollFovAccumulator = {
    get fovDeg(): number {
      return fovDeg;
    },
    get fovRad(): number {
      return (fovDeg * Math.PI) / 180;
    },
    apply(wheelDelta: number): void {
      fovDeg -= wheelDelta;
      if (fovDeg < FOV_MIN_DEG) fovDeg = FOV_MIN_DEG;
      if (fovDeg > FOV_MAX_DEG) fovDeg = FOV_MAX_DEG;
    },
  };
  return acc;
}
