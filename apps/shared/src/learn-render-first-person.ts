import { Time, Update } from '@forgeax/engine-ecs';
// learn-render-first-person.ts -- first-person camera controls SSOT for
// apps/learn-render/2.lighting/ (1, 2, 3, 4, 5, 6). Exports addFirstPersonSystem
// (with optional flashlight SpotLight narrowing), createFirstPersonControls
// (override-backend bootstrap), plus pure helpers computeWasdDisplacement
// and createScrollFovAccumulator for unit testing.
//
// Tunables: PITCH_CLAMP_RAD (89 deg), MOUSE_SENSITIVITY (0.002),
// CAMERA_FOV_RADIANS (PI/4).
//
// Yaw/pitch -> quaternion via engine-math `quat.fromEuler(...,'YXZ')`;
// forward/right vectors are derived via `quat.transformVec3` from the
// quaternion (single SSOT — no hand-rolled Tait-Bryan formula). Yaw stays
// in LO math convention (yaw=-pi/2 looks -Z, +mouse-dx increases yaw); the
// LO->engine bridge `engineYaw = -(yaw + pi/2)` makes identity quaternion
// match the LO initial pose and aligns mouse-dx with camera-right.

import type { App, BundlerOptions, CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import {
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  type InputSnapshot,
} from '@forgeax/engine-input';
import { type QuatLike, quat, vec3 } from '@forgeax/engine-math';
import { Camera, SpotLight } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export { captureCanvasPixels } from './canvas-capture';

// -------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------

export const CAMERA_SPEED_PER_SECOND = 2.5;
export const PITCH_CLAMP_RAD = (89 * Math.PI) / 180;
export const MOUSE_SENSITIVITY = 0.002;
export const CAMERA_FOV_RADIANS = Math.PI / 4;
export const FOV_MIN_DEG = 1;
export const FOV_MAX_DEG = 45;
export const FOV_INITIAL_DEG = 45;

// -------------------------------------------------------------------
// Pure math helpers (testable without ECS / renderer / WebGPU)
// -------------------------------------------------------------------

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
  readonly q?: boolean;
  readonly e?: boolean;
}

export interface DisplacementXYZ {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ScrollFovAccumulator {
  readonly fovDeg: number;
  readonly fovRad: number;
  apply(wheelDelta: number): void;
}

export function computeWasdDisplacement(
  dt: number,
  forward: Vec3Like,
  right: Vec3Like,
  held: WasdHeld,
  speedOverride?: number,
): DisplacementXYZ {
  const speed =
    (speedOverride !== undefined && speedOverride > 0 ? speedOverride : CAMERA_SPEED_PER_SECOND) *
    dt;
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
  if (held.q) {
    dy -= speed;
  }
  if (held.e) {
    dy += speed;
  }
  return { x: dx, y: dy, z: dz };
}

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

// -------------------------------------------------------------------
// ECS system builder
// -------------------------------------------------------------------

export interface FirstPersonOptions {
  readonly name: string;
  readonly overrideBackend: InputBackend | undefined;
  readonly flashlight?: { readonly spotLightQuery: true };
  readonly moveSpeed?: number;
}

const FORWARD_LOCAL: Readonly<[number, number, number]> = [0, 0, -1];
const RIGHT_LOCAL: Readonly<[number, number, number]> = [1, 0, 0];

/** Inverse of the system's `quat.fromEuler(pitch, -(yaw + pi/2), 0, 'YXZ')` (LO yaw convention). */
export function yawPitchFromQuat(q: QuatLike): { yaw: number; pitch: number } {
  const forward = quat.transformVec3(vec3.create(), q, FORWARD_LOCAL);
  const fy = Math.min(1, Math.max(-1, forward[1] ?? 0));
  return {
    yaw: -Math.atan2(-(forward[0] ?? 0), -(forward[2] ?? -1)) - Math.PI / 2,
    pitch: Math.min(PITCH_CLAMP_RAD, Math.max(-PITCH_CLAMP_RAD, Math.asin(fy))),
  };
}

export function addFirstPersonSystem(world: App['world'], opts: FirstPersonOptions): void {
  let yaw = -Math.PI / 2;
  let pitch = 0;
  let seeded = false;

  const qTmp = quat.create();
  const forwardTmp = vec3.create();
  const rightTmp = vec3.create();

  // The spawned camera pose is the initial view: derive yaw/pitch from it once
  // instead of keeping a second initial-orientation fact.
  const seedFrom = (cameraQuat: Float32Array) => {
    ({ yaw, pitch } = yawPitchFromQuat(cameraQuat));
    seeded = true;
  };

  const tick = (dt: number, snapshot: InputSnapshot) => {
    yaw += snapshot.mouse.movementDelta.x * MOUSE_SENSITIVITY;
    pitch -= snapshot.mouse.movementDelta.y * MOUSE_SENSITIVITY;
    if (pitch > PITCH_CLAMP_RAD) pitch = PITCH_CLAMP_RAD;
    if (pitch < -PITCH_CLAMP_RAD) pitch = -PITCH_CLAMP_RAD;
    quat.fromEuler(qTmp, pitch, -(yaw + Math.PI / 2), 0, 'YXZ');
    quat.transformVec3(forwardTmp, qTmp, FORWARD_LOCAL);
    quat.transformVec3(rightTmp, qTmp, RIGHT_LOCAL);
    const forward = { x: forwardTmp[0] ?? 0, y: forwardTmp[1] ?? 0, z: forwardTmp[2] ?? 0 };
    const right = { x: rightTmp[0] ?? 0, y: rightTmp[1] ?? 0, z: rightTmp[2] ?? 0 };
    const displacement = computeWasdDisplacement(
      dt,
      forward,
      right,
      {
        w: snapshot.keyboard.down('w'),
        s: snapshot.keyboard.down('s'),
        a: snapshot.keyboard.down('a'),
        d: snapshot.keyboard.down('d'),
        q: snapshot.keyboard.down('q'),
        e: snapshot.keyboard.down('e'),
      },
      opts.moveSpeed,
    );
    return { forward, displacement };
  };

  if (opts.flashlight) {
    world.addSystem(Update, {
      name: opts.name,
      after: ['input-frame-start-scan'],
      queries: [{ write: [Transform], with: [Camera] }, { write: [Transform, SpotLight] }],
      fn: (world, queries) => {
        const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        if (snapshot === undefined) return;
        const time = world.getResource(Time);
        const dt = time.delta;
        if (!seeded)
          for (const row of queries[0]) {
            seedFrom(row.mut(Transform).quat);
            break;
          }
        const { forward, displacement } = tick(dt, snapshot);

        let camPosX = 0;
        let camPosY = 0;
        let camPosZ = 3;
        for (const row of queries[0]) {
          const transform = row.mut(Transform);
          camPosX = (transform.pos[0] ?? 0) + displacement.x;
          camPosY = (transform.pos[1] ?? 0) + displacement.y;
          camPosZ = (transform.pos[2] ?? 0) + displacement.z;
          transform.pos.set([camPosX, camPosY, camPosZ]);
          transform.quat.set([qTmp[0] ?? 0, qTmp[1] ?? 0, qTmp[2] ?? 0, qTmp[3] ?? 1]);
        }

        for (const row of queries[1]) {
          row.mut(Transform).pos.set([camPosX, camPosY, camPosZ]);
          row.mut(SpotLight).direction.set([forward.x, forward.y, forward.z]);
        }
      },
    });
  } else {
    world.addSystem(Update, {
      name: opts.name,
      after: ['input-frame-start-scan'],
      queries: [{ write: [Transform], with: [Camera] }],
      fn: (world, queries) => {
        const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        if (snapshot === undefined) return;
        const time = world.getResource(Time);
        const dt = time.delta;
        if (!seeded)
          for (const row of queries[0]) {
            seedFrom(row.mut(Transform).quat);
            break;
          }
        const { displacement } = tick(dt, snapshot);

        for (const row of queries[0]) {
          const transform = row.mut(Transform);
          transform.pos.set([
            (transform.pos[0] ?? 0) + displacement.x,
            (transform.pos[1] ?? 0) + displacement.y,
            (transform.pos[2] ?? 0) + displacement.z,
          ]);
          transform.quat.set([qTmp[0] ?? 0, qTmp[1] ?? 0, qTmp[2] ?? 0, qTmp[3] ?? 1]);
        }
      },
    });
  }
}

// -------------------------------------------------------------------
// Override-backend bootstrap
// -------------------------------------------------------------------

export async function createFirstPersonControls(
  target: HTMLCanvasElement,
  overrideBackend: InputBackend,
  bundler: BundlerOptions,
): Promise<{ ok: true; value: App } | { ok: false; error: CanvasAppError }> {
  return createApp(target, { input: overrideBackend }, bundler);
}
