// apps/bevy/free-camera — shared World builder + free-camera controller.
// Reproduces Bevy's camera/free_camera_controller.rs: WASD/QE movement,
// mouse yaw/pitch, scroll speed, run modifier, and friction decay.

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

// Bevy defaults: sensitivity 0.2, friction 25.0, walk 3.0, run 9.0, scrollFactor 0.1.
export const DEFAULT_SENSITIVITY = 0.2;
export const DEFAULT_FRICTION = 25;
export const DEFAULT_WALK_SPEED = 3;
export const DEFAULT_RUN_SPEED = 9;
export const DEFAULT_SCROLL_FACTOR = 0.1;

const PITCH_LIMIT = Math.PI / 2 - 0.01;

export const FreeCamera = defineComponent('FreeCamera', {
  yaw: { type: 'f32', default: 0 },
  pitch: { type: 'f32', default: 0 },
  velocityX: { type: 'f32', default: 0 },
  velocityY: { type: 'f32', default: 0 },
  velocityZ: { type: 'f32', default: 0 },
  sensitivity: { type: 'f32', default: DEFAULT_SENSITIVITY },
  friction: { type: 'f32', default: DEFAULT_FRICTION },
  walkSpeed: { type: 'f32', default: DEFAULT_WALK_SPEED },
  runSpeed: { type: 'f32', default: DEFAULT_RUN_SPEED },
  scrollFactor: { type: 'f32', default: DEFAULT_SCROLL_FACTOR },
});

function firstCamera(world: World): EntityHandle | null {
  const query = world.query({ with: [Camera, Transform, FreeCamera] }).unwrap();
  for (const row of query) return row.entity;
  return null;
}

function colorMat(world: World, color: readonly [number, number, number, number]) {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ baseColor: color }));
}

/** Build a cube-on-plane scene viewed by a free-fly camera. */
export function buildFreeCameraWorld(world: World): void {
  const planeMat = colorMat(world, [0.3, 0.5, 0.3, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, -0.5, 0], quat: [0, 0, 0, 1], scale: [5, 0.04, 5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [planeMat] } },
  );

  const cubeMat = colorMat(world, [0.8, 0.7, 0.6, 1]);
  world.spawn(
    { component: Transform, data: { pos: [1.5, 0.5, 1.5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  );

  world.spawn(
    { component: Transform, data: { pos: [3, 8, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 30 } },
  );

  // Camera at (0, 1, 8) looking forward (-Z) — simple, easy to verify.
  // The camera faces the scene from the front.
  const startPos: [number, number, number] = [0, 1, 8];
  const startRot = quat.identity(quat.create());
  world.spawn(
    { component: Transform, data: { pos: startPos, quat: startRot, scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
    {
      component: FreeCamera,
      data: {
        yaw: 0, pitch: 0,
        velocityX: 0, velocityY: 0, velocityZ: 0,
        sensitivity: DEFAULT_SENSITIVITY,
        friction: DEFAULT_FRICTION,
        walkSpeed: DEFAULT_WALK_SPEED,
        runSpeed: DEFAULT_RUN_SPEED,
        scrollFactor: DEFAULT_SCROLL_FACTOR,
      },
    },
  );
}

/** Apply yaw/pitch from mouse delta then move/decay the camera per frame. */
export function stepFreeCamera(world: World, dt: number, snapshot: InputSnapshot): void {
  const handle = firstCamera(world);
  if (handle === null) return;
  const fc = world.get(handle, FreeCamera);
  const tf = world.get(handle, Transform);
  if (!fc.ok || !tf.ok) return;

  const kbd = snapshot.keyboard;
  const mouse = snapshot.mouse;

  let yaw = fc.value.yaw - mouse.movementDelta.x * fc.value.sensitivity;
  let pitch = fc.value.pitch - mouse.movementDelta.y * fc.value.sensitivity;
  pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));

  let walkSpeed = fc.value.walkSpeed;
  let runSpeed = fc.value.runSpeed;
  if (mouse.wheelDelta !== 0) {
    const factor = 1 + mouse.wheelDelta * fc.value.scrollFactor;
    walkSpeed = Math.max(0.1, walkSpeed * factor);
    runSpeed = Math.max(0.1, runSpeed * factor);
  }

  const speed = kbd.down('ShiftLeft') || kbd.down('ShiftRight') ? runSpeed : walkSpeed;
  const rot = quat.fromEuler(quat.create(), -pitch, yaw, 0, 'YXZ');
  const right = quat.right(vec3.create(), rot);
  const forward = quat.forward(vec3.create(), rot);

  const dx = Number(kbd.down('d')) - Number(kbd.down('a'));
  const dz = Number(kbd.down('s')) - Number(kbd.down('w'));
  const dy = Number(kbd.down('e')) - Number(kbd.down('q'));

  const desiredVx = (right[0] ?? 0) * dx * speed + (forward[0] ?? 0) * dz * speed;
  const desiredVy = dy * speed;
  const desiredVz = (right[2] ?? 0) * dx * speed + (forward[2] ?? 0) * dz * speed;

  const decay = Math.exp(-fc.value.friction * dt);
  const vx = fc.value.velocityX * decay + desiredVx * (1 - decay);
  const vy = fc.value.velocityY * decay + desiredVy * (1 - decay);
  const vz = fc.value.velocityZ * decay + desiredVz * (1 - decay);

  const pos = tf.value.pos;
  const newPos: [number, number, number] = [
    (pos[0] ?? 0) + vx * dt,
    (pos[1] ?? 0) + vy * dt,
    (pos[2] ?? 0) + vz * dt,
  ];

  const newRot = quat.fromEuler(quat.create(), -pitch, yaw, 0, 'YXZ');

  world.set(handle, FreeCamera, {
    yaw, pitch,
    velocityX: vx, velocityY: vy, velocityZ: vz,
    sensitivity: fc.value.sensitivity,
    friction: fc.value.friction,
    walkSpeed,
    runSpeed,
    scrollFactor: fc.value.scrollFactor,
  });
  world.set(handle, Transform, { pos: newPos, quat: newRot });
}

/** Current camera position, used by the smoke to prove movement. */
export function cameraPosition(world: World): [number, number, number] {
  const handle = firstCamera(world);
  if (handle === null) return [0, 0, 0];
  const tf = world.get(handle, Transform);
  if (!tf.ok) return [0, 0, 0];
  const p = tf.value.pos;
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}
