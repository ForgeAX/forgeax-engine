// apps/bevy/camera-orbit — shared World builder + deterministic camera-orbit step.
// Reproduces the spatial contract of Bevy's camera/camera_orbit.rs: a camera
// maintains a fixed radius around a static target while yaw and pitch evolve.

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import type { InputSnapshot } from '@forgeax/engine-input';
import { quat, vec3 } from '@forgeax/engine-math';

// Matches Bevy's initial Transform::from_xyz(5, 5, 5).
export const ORBIT_DISTANCE = Math.sqrt(75);
export const INITIAL_YAW = Math.PI / 4;
export const INITIAL_PITCH = Math.asin(1 / Math.sqrt(3));
export const PITCH_LIMIT = Math.PI / 2 - 0.01;
export const YAW_SENSITIVITY = 0.004;
export const PITCH_SENSITIVITY = 0.003;
export const ROLL_SPEED = 1;

/** The documented mouse input slice consumed by the orbit step. */
export interface CameraOrbitInput {
  readonly movementDelta: { readonly x: number; readonly y: number };
  readonly leftPressed: boolean;
  readonly rightPressed: boolean;
}

/** App-owned camera state matching Bevy's CameraSettings plus its accumulated orbit angles. */
export const OrbitCamera = defineComponent('OrbitCamera', {
  yaw: { type: 'f32', default: Math.PI / 4 },
  pitch: { type: 'f32', default: 0.35 },
  roll: { type: 'f32', default: 0 },
  radius: { type: 'f32', default: ORBIT_DISTANCE },
});

/** Pure spherical position helper for the camera's fixed-radius orbit. */
export function orbitPosition(yaw: number, pitch: number, radius: number): [number, number, number] {
  const cosPitch = Math.cos(pitch);
  return [
    Math.sin(yaw) * cosPitch * radius,
    Math.sin(pitch) * radius,
    Math.cos(yaw) * cosPitch * radius,
  ];
}

function firstCamera(world: World): EntityHandle | null {
  const query = world.query({ with: [Camera, Transform, OrbitCamera] }).unwrap();
  for (const row of query) return row.entity;
  return null;
}

/** Build a cube-on-plane scene viewed by a fixed-radius orbit camera. */
export function buildCameraOrbitWorld(world: World): void {
  const planeMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.3, 0.5, 0.3, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, -0.5, 0], quat: [0, 0, 0, 1], scale: [5, 0.04, 5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [planeMaterial] } },
  );

  const cubeMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.8, 0.7, 0.6, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [1.5, 0.5, 1.5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMaterial] } },
  );

  world.spawn(
    { component: Transform, data: { pos: [3, 8, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 30 } },
  );

  const position = orbitPosition(INITIAL_YAW, INITIAL_PITCH, ORBIT_DISTANCE);
  world.spawn(
    {
      component: Transform,
      data: { pos: position, quat: quat.fromLookAt(quat.create(), position, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
    { component: OrbitCamera, data: { yaw: INITIAL_YAW, pitch: INITIAL_PITCH, roll: 0, radius: ORBIT_DISTANCE } },
  );
}

/** Apply Bevy's mouse yaw/pitch + button roll rules and derive the orbit pose. */
export function stepCameraOrbit(world: World, dt: number, input: CameraOrbitInput): void {
  const handle = firstCamera(world);
  if (handle === null) return;
  const camera = world.get(handle, OrbitCamera);
  if (!camera.ok) return;
  const yaw = camera.value.yaw + input.movementDelta.x * YAW_SENSITIVITY;
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.value.pitch + input.movementDelta.y * PITCH_SENSITIVITY));
  const rollDirection = Number(input.rightPressed) - Number(input.leftPressed);
  const roll = camera.value.roll + rollDirection * ROLL_SPEED * dt;
  // Local −Z forward means the stored positive pitch raises the camera, so
  // the equivalent Euler X rotation has the opposite sign.
  const rotation = quat.fromEuler(quat.create(), -pitch, yaw, roll, 'YXZ');
  const forward = quat.transformVec3(vec3.create(), rotation, [0, 0, -1]);
  const position: [number, number, number] = [
    -(forward[0] ?? 0) * camera.value.radius,
    -(forward[1] ?? 0) * camera.value.radius,
    -(forward[2] ?? 0) * camera.value.radius,
  ];
  world.set(handle, OrbitCamera, { yaw, pitch, roll });
  world.set(handle, Transform, { pos: position, quat: rotation });
}

/** Project the frame-start InputSnapshot onto the camera orbit's documented controls. */
export function cameraOrbitInput(snapshot: InputSnapshot): CameraOrbitInput {
  return {
    movementDelta: snapshot.mouse.movementDelta,
    leftPressed: snapshot.mouse.button(0),
    rightPressed: snapshot.mouse.button(2),
  };
}

/** Current camera radius, used by the smoke to prove the orbit invariant. */
export function cameraRadius(world: World): number {
  const handle = firstCamera(world);
  if (handle === null) return Number.NaN;
  const transform = world.get(handle, Transform);
  if (!transform.ok) return Number.NaN;
  const pos = transform.value.pos;
  return Math.hypot(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0);
}
