// apps/bevy/2d-top-down-camera — shared 2D top-down World builder + camera
// tracking. Reproduces Bevy's camera/2d_top_down_camera.rs: player icon moves
// via WASD, orthographic camera smooth-tracks via exponential-decay damping.
//
// Bevy source (references/repos/bevy/examples/camera/2d_top_down_camera.rs):
// "This example showcases a 2D top-down camera with smooth player tracking."
// Player moves with WASD, camera smoothly tracks the player's x,y position.
//
// forgeax mapping (thin over existing primitives — no engine gap):
//   - orthographic camera: Camera + orthographic() — proven in orthographic demo
//   - quad mesh: MeshFilter + HANDLE_CUBE, flat-scaled at Z=0
//   - WASD input: InputSnapshot — proven in camera-pan + free-camera
//   - smooth tracking: vec3.smoothDamp — proven in smooth-follow demo
//   - motion front door: createApp + world.addSystem — proven in all motion demos
//
// Bevy constants: player speed=100, camera decay rate=2.0

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
import { vec3 } from '@forgeax/engine-math';

/** Bevy PLAYER_SPEED = 100. */
const PLAYER_SPEED = 100;

/** Bevy CAMERA_DECAY_RATE = 2.0. */
const CAMERA_DECAY_RATE = 2.0;

/** Bevy world: 1000×700 background. Orthographic extents half that. */
const WORLD_W = 1000;
const WORLD_H = 700;
const ORTHO_HALF_W = WORLD_W / 2;
const ORTHO_HALF_H = WORLD_H / 2;

/** Marker component for the player entity. */
export const Player = defineComponent('Player', {});

function firstCamera(world: World): EntityHandle | null {
  const query = world.query({ with: [Camera, Transform] }).unwrap();
  for (const row of query) return row.entity;
  return null;
}

function firstPlayer(world: World): EntityHandle | null {
  const query = world.query({ with: [Player, Transform] }).unwrap();
  for (const row of query) return row.entity;
  return null;
}

/** Build the 2D top-down scene: floor + player quad + orthographic camera. */
export function buildTopDownWorld(world: World): void {
  // ── Floor background (dark blue, Bevy srgb(0.2, 0.2, 0.3)) ─────────
  const floorMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.2, 0.2, 0.3, 1]),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [WORLD_W, WORLD_H, 0.01] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [floorMat] } },
  );

  // ── Player icon (bright cyan, Bevy srgb(6.25, 9.4, 9.1) → clamped) ──
  const playerMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.25, 0.94, 0.91, 1]),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 2], quat: [0, 0, 0, 1], scale: [25, 25, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [playerMat] } },
    { component: Player, data: {} },
  );

  // ── Orthographic camera at Z=999.9 (Bevy default Camera2d z-order) ──
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
  );
}

/** Move player with WASD and smooth-track camera toward player. */
export function stepTopDownCamera(world: World, dt: number, snapshot: InputSnapshot): void {
  const kbd = snapshot.keyboard;

  // ── Move player ─────────────────────────────────────────────────────
  const playerHandle = firstPlayer(world);
  if (playerHandle !== null) {
    const tf = world.get(playerHandle, Transform);
    if (tf.ok) {
      const pos = tf.value.pos;
      let dx = 0, dy = 0;
      if (kbd.down('w') || kbd.down('W')) dy += 1;
      if (kbd.down('s') || kbd.down('S')) dy -= 1;
      if (kbd.down('a') || kbd.down('A')) dx -= 1;
      if (kbd.down('d') || kbd.down('D')) dx += 1;

      // Normalize direction (Bevy: direction.normalize_or_zero())
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) { dx /= len; dy /= len; }

      const newX = (pos[0] ?? 0) + dx * PLAYER_SPEED * dt;
      const newY = (pos[1] ?? 0) + dy * PLAYER_SPEED * dt;
      world.set(playerHandle, Transform, { pos: [newX, newY, 2], quat: [0, 0, 0, 1] });
    }
  }

  // ── Smooth-track camera toward player ───────────────────────────────
  const camHandle = firstCamera(world);
  if (camHandle !== null && playerHandle !== null) {
    const camTf = world.get(camHandle, Transform);
    const playerTf = world.get(playerHandle, Transform);
    if (camTf.ok && playerTf.ok) {
      const curPos = camTf.value.pos;
      const playerPos = playerTf.value.pos;
      const target: [number, number, number] = [playerPos[0] ?? 0, playerPos[1] ?? 0, curPos[2] ?? 999.9];
      const damped = vec3.create();
      vec3.smoothDamp(damped, [curPos[0] ?? 0, curPos[1] ?? 0, curPos[2] ?? 999.9], target, CAMERA_DECAY_RATE, dt);
      world.set(camHandle, Transform, { pos: damped, quat: [0, 0, 0, 1] });
    }
  }
}

/** Current camera position, used by the smoke to prove tracking. */
export function cameraPosition(world: World): [number, number, number] {
  const handle = firstCamera(world);
  if (handle === null) return [0, 0, 0];
  const tf = world.get(handle, Transform);
  if (!tf.ok) return [0, 0, 0];
  const p = tf.value.pos;
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}
