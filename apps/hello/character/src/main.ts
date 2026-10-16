// apps/hello/character — Kinematic character controller demo.
//
// Drives a capsule character with PhysicsWorld.moveAndSlide (feat-20260617 G-2):
//   - WASD: planar movement intent (camera-relative +x / +z plane).
//   - Space: jump (sets an upward velocity that decays under gravity).
//   - Gravity is integrated into the per-frame desiredDelta; moveAndSlide
//     resolves it against the static level geometry (ground + ramp + step + box).
//   - CharacterController.grounded is read back each frame and visualized:
//     the debug-draw capsule outline is GREEN when grounded, RED when airborne.
//
// The physics backend (Rapier 3D WASM) loads asynchronously via createApp's
// fire-and-forget loader, so the per-frame driver waits for the `PhysicsWorld`
// resource to appear before issuing moveAndSlide. Until then the character
// holds its spawn pose.

import type { CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update, type World } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  type PhysicsWorld,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// Capsule character dims: radius 0.3 + halfHeight 0.5 -> half-total 0.8.
const CHAR_RADIUS = 0.3;
const CHAR_HALF_HEIGHT = 0.5;
const CHAR_HALF_TOTAL = CHAR_RADIUS + CHAR_HALF_HEIGHT;
// Ground top sits at y=-0.35 (box center -0.85, halfExtentY 0.5), so the
// capsule rests with its center at y=0.45 (never spawn buried — KCC needs a
// clean contact for slope/step handling).
const GROUND_TOP_Y = -0.35;
const CHAR_REST_Y = GROUND_TOP_Y + CHAR_HALF_TOTAL;

const MOVE_SPEED = 4; // units/second planar
const GRAVITY = -12; // units/second^2
const JUMP_SPEED = 6; // units/second initial upward

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-character: missing <canvas id="app"> in index.html');

const app = await createApp(canvas, { plugins: [physicsPlugin('rapier-3d')] }, forgeaxBundlerAdapter());
if (!app.ok) {
  reportError(app.error);
} else {
  const character = spawnScene(app.value.world);
  driveCharacter(app.value, character);
  app.value.start();
}

function spawnScene(world: World): number {
  // Ground slab.
  world
    .spawn(
      { component: Transform, data: { pos: [0, -0.85, 0], scale: [20, 1, 20]} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.cuboid,
          halfExtents: [10, 0.5, 10],
        },
      },
    )
    .unwrap();

  // A low step ledge to walk up (auto-step territory: 0.2m < default 0.3m).
  world
    .spawn(
      { component: Transform, data: { pos: [3, -0.45, 0], scale: [2, 0.4, 8]} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.cuboid,
          halfExtents: [1, 0.2, 4],
        },
      },
    )
    .unwrap();

  // A tall box to bump into (collision response / wall slide).
  world
    .spawn(
      { component: Transform, data: { pos: [-3, 0.5, -2], scale: [1, 2, 1]} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.cuboid,
          halfExtents: [0.5, 1, 0.5],
        },
      },
    )
    .unwrap();

  // The character: kinematic capsule + CharacterController, resting on the ground.
  const character = world
    .spawn(
      { component: Transform, data: { pos: [0, CHAR_REST_Y, 0]} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.capsule,
          radius: CHAR_RADIUS,
          halfHeight: CHAR_HALF_HEIGHT,
        },
      },
      { component: CharacterController, data: {} },
    )
    .unwrap();

  // Camera looking at the play area.
  world
    .spawn(
      { component: Transform, data: { pos: [0, 6, 12]} },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 } },
    )
    .unwrap();

  // Directional light.
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.4, -1, -0.3],
        color: [1, 1, 1],
        intensity: 1,
      },
    })
    .unwrap();

  return character as unknown as number;
}

function driveCharacter(
  app: import('@forgeax/engine-app').App,
  character: number,
): void {
  const hud = document.querySelector<HTMLPreElement>('#hud');
  let verticalVel = 0; // accumulated jump/gravity velocity (units/sec)

  app.world
    .addSystem(Update, {
      name: 'character-drive',
      queries: [],
      fn: () => {
        const dt = app.world.getResource(Time).delta;

    // Wait for the async Rapier WASM to insert the PhysicsWorld resource.
    let pw: PhysicsWorld;
    try {
      pw = app.world.getResource<PhysicsWorld>('PhysicsWorld');
    } catch {
      return;
    }

    // The PhysicsWorld resource exists but the character's Rapier body may not
    // have been built yet by the first physicsSyncBackend tick (WASM fire-and-
    // forget). Guard with hasBody to avoid the body-not-found throw — don't
    // integrate gravity or read position during this window.
    if (!pw.hasBody(character)) return;

    const snap = app.world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    let dx = 0;
    let dz = 0;
    if (snap) {
      if (snap.keyboard.down('w') || snap.keyboard.down('W')) dz -= 1;
      if (snap.keyboard.down('s') || snap.keyboard.down('S')) dz += 1;
      if (snap.keyboard.down('a') || snap.keyboard.down('A')) dx -= 1;
      if (snap.keyboard.down('d') || snap.keyboard.down('D')) dx += 1;
    }
    // Normalize planar intent so diagonal isn't faster.
    const len = Math.hypot(dx, dz);
    if (len > 0) {
      dx = (dx / len) * MOVE_SPEED * dt;
      dz = (dz / len) * MOVE_SPEED * dt;
    }

    const grounded = readGrounded(app.world, character);

    // Jump: only when grounded; otherwise integrate gravity.
    if (grounded && snap && snap.keyboard.down(' ')) {
      verticalVel = JUMP_SPEED;
    }
    verticalVel += GRAVITY * dt;
    // When grounded and not jumping, keep a small downward bias so the KCC
    // stays glued to the surface (snap-to-ground); clamp so it does not grow.
    if (grounded && verticalVel < 0) verticalVel = GRAVITY * dt;
    const dy = verticalVel * dt;

    pw.moveAndSlide(character, vec3.create(dx, dy, dz));

    // Re-read grounded after the move and visualize it on the capsule.
    const groundedNow = readGrounded(app.world, character);
    if (groundedNow) verticalVel = 0; // landed -> reset accumulated fall

    drawCharacterGizmo(app, character, groundedNow);

    if (hud) {
      const p = readPos(app.world, character);
      hud.textContent = `WASD move - Space jump\npos ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}\ngrounded ${groundedNow}`;
    }
      },
    })
    .unwrap();
}

function readGrounded(world: World, entity: number): boolean {
  const r = world.get(entity as never, CharacterController as never);
  if (!r.ok) return false;
  // bool schema field -> JS boolean (compare directly, not `!== 0`).
  return (r.value as { grounded: boolean }).grounded === true;
}

function readPos(world: World, entity: number): { x: number; y: number; z: number } {
  const r = world.get(entity as never, Transform as never);
  if (!r.ok) return { x: 0, y: 0, z: 0 };
  const v = r.value as { pos: Float32Array };
  return { x: v.pos[0] ?? 0, y: v.pos[1] ?? 0, z: v.pos[2] ?? 0 };
}

function drawCharacterGizmo(
  app: import('@forgeax/engine-app').App,
  character: number,
  grounded: boolean,
): void {
  const dd = app.debugDraw;
  if (!dd) return;
  const p = readPos(app.world, character);
  const color: [number, number, number, number] = grounded ? [0, 1, 0, 1] : [1, 0, 0, 1];
  // Capsule outline approximated by two stacked spheres (top + bottom caps)
  // plus an AABB hull — enough to read the grounded state visually.
  dd.sphere(vec3.create(p.x, p.y + CHAR_HALF_HEIGHT, p.z), CHAR_RADIUS, color);
  dd.sphere(vec3.create(p.x, p.y - CHAR_HALF_HEIGHT, p.z), CHAR_RADIUS, color);
  dd.aabb(
    vec3.create(p.x - CHAR_RADIUS, p.y - CHAR_HALF_TOTAL, p.z - CHAR_RADIUS),
    vec3.create(p.x + CHAR_RADIUS, p.y + CHAR_HALF_TOTAL, p.z + CHAR_RADIUS),
    color,
  );
}

function reportError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    console.error(
      `[hello-character] EngineEnvironmentError: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  switch (err.code) {
    case 'app-not-started':
    case 'app-already-running':
    case 'app-canvas-detached':
    case 'app-system-update-failed':
    case 'app-pointer-lock-failed':
    case 'adapter-unavailable':
    case 'feature-not-enabled':
    case 'limit-exceeded':
    case 'shader-compile-failed':
    case 'rhi-not-available':
    case 'webgpu-runtime-error':
    case 'command-encoder-finished':
    case 'render-pass-not-ended':
    case 'queue-submit-failed':
    case 'queue-write-buffer-out-of-bounds':
    case 'render-system-no-camera':
    case 'render-system-multi-camera':
    case 'render-system-multi-light':
    case 'asset-not-registered':
    case 'device-lost':
    case 'oom':
    case 'internal-error':
    case 'hierarchy-broken':
      console.error(`[hello-character] ${err.code}: ${err.hint}`);
      return;
  }
}
