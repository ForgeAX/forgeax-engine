// apps/bevy/2d-screen-shake — shared 2D screen shake World builder + per-frame
// trauma update. Reproduces Bevy's camera/2d_screen_shake.rs: trauma-based camera
// shake with 1D Perlin noise, Space to increase trauma, automatic decay.
//
// Bevy source (references/repos/bevy/examples/camera/2d_screen_shake.rs):
// "This example showcases how to implement 2D screen shake."
// GDC talk "Math for Game Programmers: Juicing Your Cameras With Math" by Squirrel Eiserloh.
// Key features: trauma [0,1], noise-driven displacement, trauma decay, unshaken
// base transform restored each frame.
//
// forgeax mapping (engine-first: new noise.perlin1d primitive, then thin demo):
//   - Perlin noise: noise.perlin1d — the 10th math namespace, added in this round
//   - orthographic camera: Camera + orthographic() — proven in 2d-top-down-camera
//   - quad meshes: MeshFilter + HANDLE_CUBE, flat-scaled
//   - Space input: InputSnapshot — proven in camera-pan + free-camera
//   - motion front door: createApp + world.addSystem — proven in all motion demos
//
// Bevy constants: trauma decay=0.5/s, exponent=2.0, max_angle=10°, max_translation=20px,
// noise_speed=20.0, trauma_per_press=0.4

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { orthographic } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import type { InputSnapshot } from '@forgeax/engine-input';
import { noise, quat } from '@forgeax/engine-math';

/** Bevy TRAUMA_DECAY_PER_SECOND = 0.5. */
const TRAUMA_DECAY_PER_SECOND = 0.5;

/** Bevy TRAUMA_EXPONENT = 2.0. */
const TRAUMA_EXPONENT = 2.0;

/** Bevy MAX_ANGLE = 10.0 degrees in radians. */
const MAX_ANGLE = (10.0 * Math.PI) / 180;

/** Bevy MAX_TRANSLATION = 20.0. */
const MAX_TRANSLATION = 20.0;

/** Bevy NOISE_SPEED = 20.0. */
const NOISE_SPEED = 20.0;

/** Bevy TRAUMA_PER_PRESS = 0.4. */
const TRAUMA_PER_PRESS = 0.4;

/** Bevy world: 1000×700 background. Orthographic extents half that. */
const WORLD_W = 1000;
const WORLD_H = 700;
const ORTHO_HALF_W = WORLD_W / 2;
const ORTHO_HALF_H = WORLD_H / 2;

/** Component: camera shake state — trauma + base camera transform. */
export const CameraShakeState = defineComponent('CameraShakeState', {
  trauma: { type: 'f32', default: 0 },
  basePosX: { type: 'f32', default: 0 },
  basePosY: { type: 'f32', default: 0 },
  basePosZ: { type: 'f32', default: 0 },
});

function firstCamera(world: World): EntityHandle | null {
  const query = world.query({ with: [Camera, Transform, CameraShakeState] }).unwrap();
  for (const row of query) return row.entity;
  return null;
}

/** Build the 2D screen-shake scene: background + player + obstacles + camera. */
export function buildScreenShakeWorld(world: World): void {
  // ── Background tile (dark blue, Bevy srgb(0.2, 0.2, 0.3)) ─────────
  const bgMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.2, 0.2, 0.3, 1]),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [WORLD_W, WORLD_H, 0.01] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [bgMat] } },
  );

  // ── Player icon (cyan, Bevy srgb(0.25, 0.94, 0.91)) ──────────────
  const playerMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.25, 0.94, 0.91, 1]),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 2], quat: [0, 0, 0, 1], scale: [50, 100, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [playerMat] } },
  );

  // ── Obstacle 1 (red, Bevy srgb(0.85, 0.0, 0.2)) ──────────────────
  const obs1Mat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.85, 0.0, 0.2, 1]),
  );
  world.spawn(
    { component: Transform, data: { pos: [-450, 200, 2], quat: [0, 0, 0, 1], scale: [50, 50, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [obs1Mat] } },
  );

  // ── Obstacle 2 (green, Bevy srgb(0.5, 0.8, 0.2)) ──────────────────
  const obs2Mat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.5, 0.8, 0.2, 1]),
  );
  world.spawn(
    { component: Transform, data: { pos: [450, -150, 2], quat: [0, 0, 0, 1], scale: [70, 50, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [obs2Mat] } },
  );

  // ── Orthographic camera at Z=999.9 ──────────────────────────────────
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 999.9], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    },
    {
      component: Camera,
      data: orthographic({
        left: -ORTHO_HALF_W,
        right: ORTHO_HALF_W,
        bottom: -ORTHO_HALF_H,
        top: ORTHO_HALF_H,
        near: 0.1,
        far: 2000,
      }),
    },
    { component: CameraShakeState, data: { trauma: 0, basePosX: 0, basePosY: 0, basePosZ: 999.9 } },
  );
}

/** Step the screen shake: increase trauma on Space press, then apply shake. */
export function stepScreenShake(world: World, dt: number, elapsed: number, snapshot: InputSnapshot): void {
  const camHandle = firstCamera(world);
  if (camHandle === null) return;

  const cs = world.get(camHandle, CameraShakeState);
  if (!cs.ok) return;

  let { trauma } = cs.value;
  const basePosX = (cs.value as Record<string, number>).basePosX ?? 0;
  const basePosY = (cs.value as Record<string, number>).basePosY ?? 0;
  const basePosZ = (cs.value as Record<string, number>).basePosZ ?? 0;

  // ── Increase trauma on Space ───────────────────────────────────────
  if (snapshot.keyboard.down(' ')) {
    trauma = Math.min(1, trauma + TRAUMA_PER_PRESS);
  }

  // ── Apply shake ─────────────────────────────────────────────────────
  const t = elapsed * NOISE_SPEED;
  const rotationNoise = noise.perlin1d(t);
  const xNoise = noise.perlin1d(t + 100);
  const yNoise = noise.perlin1d(t + 200);

  const shake = trauma ** TRAUMA_EXPONENT;
  const rollOffset = rotationNoise * shake * MAX_ANGLE;
  const xOffset = xNoise * shake * MAX_TRANSLATION;
  const yOffset = yNoise * shake * MAX_TRANSLATION;

  // Apply offset to camera transform (base position + noise displacement).
  const axisRot = quat.create();
  // The camera has identity rotation; apply pure Z-axis roll offset.
  quat.fromAxisAngle(axisRot, [0, 0, 1], rollOffset);

  world.set(camHandle, Transform, {
    pos: [basePosX + xOffset, basePosY + yOffset, basePosZ],
    quat: [axisRot[0] ?? 0, axisRot[1] ?? 0, axisRot[2] ?? 0, axisRot[3] ?? 1],
  });

  // ── Decay trauma ────────────────────────────────────────────────────
  trauma = Math.max(0, trauma - TRAUMA_DECAY_PER_SECOND * dt);

  // ── Save updated state ──────────────────────────────────────────────
  world.set(camHandle, CameraShakeState, {
    trauma,
    basePosX,
    basePosY,
    basePosZ,
  });
}

/** Current camera trauma, used by the smoke to prove shake. */
export function cameraTrauma(world: World): number {
  const handle = firstCamera(world);
  if (handle === null) return 0;
  const cs = world.get(handle, CameraShakeState);
  if (!cs.ok) return 0;
  return (cs.value as { trauma: number }).trauma;
}

/** Current camera position, used by the smoke to prove shake displacement. */
export function cameraPosition(world: World): [number, number, number] {
  const handle = firstCamera(world);
  if (handle === null) return [0, 0, 0];
  const tf = world.get(handle, Transform);
  if (!tf.ok) return [0, 0, 0];
  const p = tf.value.pos;
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}
