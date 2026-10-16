// apps/collectathon -- player-move: KCC movement + input + third-person camera.
//
// This file owns the parent (KCC) Transform writer. Per-frame:
//   (1) two guards (D-9): PhysicsWorld resource present + hasBody(player) -- the
//       Rapier WASM loads async, so the first frames must no-op rather than throw
//   (2) planar intent from WASD, rotated into the camera's XZ basis
//   (3) vertical velocity integrated from gravity + grounded jump (D-8: grounded
//       read as a real boolean, compared === true, NEVER !== 0)
//   (4) PhysicsWorld.moveAndSlide writes the parent Transform.local
//   (5) third-person camera follows the player at a fixed orbit offset
//
// The pure decision helpers (planarIntent / readGrounded / integrateVertical)
// are exported and unit-tested in __tests__/player-move.test.ts; the closure
// system fn wires them to the live app input + physics.

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import type { Mat4Like, Vec3 } from '@forgeax/engine-math';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import { CharacterController } from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';

import { readDt } from './frame-time';

export const MOVE_SPEED = 4; // units/second planar
export const GRAVITY = -12; // units/second^2
export const JUMP_SPEED = 6; // units/second initial upward

// Facing: humanoid.fbx authors the rig facing +Z in model space (after the
// cm->world scale, with no extra rotation the mesh looks down +Z). To face the
// world planar move direction (mx, mz) we yaw about +Y by the angle that turns
// +Z onto (mx, mz): atan2(mx, mz). The model is rotated, not the move basis, so
// WASD-into-camera-space stays exactly as D7 fixed it.
export function facingYawFromMove(mx: number, mz: number): number {
  return Math.atan2(mx, mz);
}

// Build a Y-axis quaternion (xyzw) for a yaw angle. Pure so the facing sign is
// unit-testable without a live Transform.
export function yawQuat(yaw: number): { x: number; y: number; z: number; w: number } {
  const half = yaw * 0.5;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

// Third-person orbit: camera sits behind (+z) and above (+y) the player.
// Exported so spawnCamera in main.ts can reuse the same orbit offset for the
// initial camera pose, keeping the spawn config and runtime follow in sync.
export const CAMERA_OFFSET_Y = 5;
export const CAMERA_OFFSET_Z = 9;

// Minimal structural views so the pure helpers do not depend on the full
// World / InputSnapshot surfaces (keeps them unit-testable with fakes).
interface KeyboardLike {
  readonly keyboard: { down(key: string): boolean };
}
interface WorldGetLike {
  get(
    entity: EntityHandle,
    component: typeof CharacterController,
  ): { ok: true; value: { grounded: boolean } } | { ok: false };
}

/**
 * Read CharacterController.grounded as a real boolean (D-8 / P-08).
 *
 * The schema bool field round-trips to a JS boolean; compare it `=== true`
 * directly. The historical bug (memory bool-field-compared-with-not-equal-zero)
 * is `grounded !== 0`, which is ALWAYS true for a boolean -- never do that.
 * Missing CharacterController returns false (never throws) so the two-guard
 * window stays safe.
 */
export function readGrounded(world: WorldGetLike, entity: EntityHandle): boolean {
  const r = world.get(entity, CharacterController);
  if (!r.ok) return false;
  return r.value.grounded === true;
}

/**
 * WASD -> normalized planar intent in the camera-local XZ basis convention:
 * W = forward (-z), S = back (+z), A = left (-x), D = right (+x). Diagonal is
 * unit-normalized so it is not faster than a cardinal direction.
 */
export function planarIntent(snap: KeyboardLike): { dx: number; dz: number } {
  let dx = 0;
  let dz = 0;
  const kb = snap.keyboard;
  if (kb.down('w') || kb.down('W')) dz -= 1;
  if (kb.down('s') || kb.down('S')) dz += 1;
  if (kb.down('a') || kb.down('A')) dx -= 1;
  if (kb.down('d') || kb.down('D')) dx += 1;
  const len = Math.hypot(dx, dz);
  if (len > 0) {
    dx /= len;
    dz /= len;
  }
  return { dx, dz };
}

export interface VerticalState {
  readonly velocity: number;
  readonly grounded: boolean;
  readonly jump: boolean;
}
export interface VerticalParams {
  readonly gravity: number;
  readonly jumpSpeed: number;
  readonly dt: number;
}

/**
 * Integrate one vertical-velocity step. Grounded + jump applies the jump
 * impulse; otherwise gravity accumulates. When grounded and falling, the result
 * is clamped to a single gravity step (snap-to-ground glue) so a long fall does
 * not build up while standing.
 */
export function integrateVertical(state: VerticalState, params: VerticalParams): number {
  let v = state.velocity;
  if (state.grounded && state.jump) {
    v = params.jumpSpeed;
  }
  v += params.gravity * params.dt;
  if (state.grounded && !state.jump && v < 0) {
    v = params.gravity * params.dt;
  }
  return v;
}

/**
 * One-way movement signal produced by player-move and consumed by player-anim.
 *
 * player-move is the sole writer (it already holds the input + grounded read);
 * player-anim reads `moving` / `grounded` to drive the crossfade WITHOUT
 * re-querying the input snapshot (plan D-3 / D-5: the locomotion signal flows
 * one direction, no duplicated input read). Mutated in place each frame.
 */
export interface PlayerMoveSignal {
  /** True while the player has nonzero planar movement intent this frame. */
  moving: boolean;
  /** Grounded state read back after the most recent moveAndSlide. */
  grounded: boolean;
}

export function createPlayerMoveSignal(): PlayerMoveSignal {
  return { moving: false, grounded: false };
}

/**
 * Build the player-move system bound to a live app + the player parent entity
 * + the third-person camera entity.
 *
 * Factory form (not a bare defineSystem) because the per-frame fn needs the
 * app's input snapshot and physics resource, which the descriptor fn (world
 * only) cannot reach. One defineSystem per domain file preserves AC-20 grep
 * locality. The player + camera handles are captured (mirrors the hello-demo
 * idiom of closing over known entity handles rather than re-querying).
 */
export function createMoveSystem(
  player: EntityHandle,
  camera: EntityHandle,
  signal: PlayerMoveSignal,
): SystemHandle<readonly []> {
  let verticalVel = 0;
  // Scratch vectors reused per frame (no per-frame allocation in the hot path).
  const fwd = vec3.create();
  const right = vec3.create();

  return defineSystem({
    name: 'player-move',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: (world: World) => {
      // Guard 1 (D-9): PhysicsWorld resource appears only after Rapier WASM
      // finishes its async load. getResource throws until then -- swallow + skip.
      let pw: PhysicsWorld;
      try {
        pw = world.getResource<PhysicsWorld>('PhysicsWorld');
      } catch {
        return;
      }
      // Guard 2 (D-9): the body may not be built by the first physics tick.
      if (!pw.hasBody(player)) return;

      const dt = readDt(world);
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      const intent = snap ? planarIntent(snap) : { dx: 0, dz: 0 };

      // Rotate the planar intent into the camera's world XZ basis so W always
      // moves away from the camera regardless of orbit yaw.
      const basis = cameraPlanarBasis(world, camera, fwd, right);
      const rightX = right[0] ?? 1;
      const rightZ = right[2] ?? 0;
      const moveX = (rightX * intent.dx + basis.fwdX * -intent.dz) * MOVE_SPEED * dt;
      const moveZ = (rightZ * intent.dx + basis.fwdZ * -intent.dz) * MOVE_SPEED * dt;

      const grounded = readGrounded(world as unknown as WorldGetLike, player);
      const jump = snap ? snap.keyboard.down(' ') : false;
      verticalVel = integrateVertical(
        { velocity: verticalVel, grounded, jump },
        { gravity: GRAVITY, jumpSpeed: JUMP_SPEED, dt },
      );
      const dy = verticalVel * dt;

      pw.moveAndSlide(player, vec3.create(moveX, dy, moveZ));

      // Face the planar move direction. moveAndSlide writes back ONLY position
      // (rapier3d computeMove sets Transform.pos + grounded, never rotation), so
      // without this the parent quat stays at spawn identity forever and the rig
      // never turns (D2). The capsule collider is Y-symmetric, so yawing the KCC
      // parent is physics-safe; propagateTransforms rotates the child rig with it.
      // world.set is a partial merge, so the position moveAndSlide just wrote
      // survives this rotation-only write.
      if (moveX !== 0 || moveZ !== 0) {
        const q = yawQuat(facingYawFromMove(moveX, moveZ));
        world.set(player, Transform, { quat: [q.x, q.y, q.z, q.w] });
      }

      // Publish the locomotion signal for player-anim (one-way producer).
      signal.moving = intent.dx !== 0 || intent.dz !== 0;

      // Landed -> reset accumulated fall so the next jump starts clean.
      const groundedNow = readGrounded(world as unknown as WorldGetLike, player);
      if (groundedNow) verticalVel = 0;
      signal.grounded = groundedNow;

      followCamera(world, player, camera);
    },
  });
}

/**
 * Compute the camera Transform rotation (as a quaternion xyzw) for a
 * third-person orbit: camera at `eye`, looking at `target`, with `up` as the
 * world up direction.
 *
 * Uses mat4.lookAt to build the view matrix, inverts it to get the camera's
 * world transform, then mat4.decompose extracts the rotation quaternion.
 * Returns the quaternion as an [x, y, z, w] tuple suitable for writing to
 * Transform.quat.
 *
 * Pure — no World dependency, unit-testable.
 */
export function cameraLookAtQuat(
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  targetX: number,
  targetY: number,
  targetZ: number,
  upX: number,
  upY: number,
  upZ: number,
): readonly [number, number, number, number] {
  const view = mat4.create();
  const eye = vec3.create(eyeX, eyeY, eyeZ);
  const target = vec3.create(targetX, targetY, targetZ);
  const up = vec3.create(upX, upY, upZ);
  mat4.lookAt(view, eye, target, up);
  // The view matrix maps world → camera; invert to get camera's world mat4.
  const worldMat = mat4.create();
  mat4.invert(worldMat, view);
  const t = vec3.create();
  const r = quat.create();
  const s = vec3.create();
  mat4.decompose(t, r, s, worldMat as Mat4Like);
  return [r[0] as number, r[1] as number, r[2] as number, r[3] as number];
}

/**
 * Project a camera world-forward vector onto the XZ plane and derive the planar
 * forward + right basis used to rotate WASD intent into world space.
 *
 * right = cross(forward, up) with up=+Y, i.e. `(-fwdZ, 0, fwdX)`. The historical
 * bug (D7) used `(fwdZ, 0, -fwdX)` -- the negated right -- which swapped A/D.
 * Sanity: a camera looking down -Z has forward=(0,0,-1) -> right=(+1,0,0)=+X, so
 * pressing D (dx=+1) sends the player toward screen-right.
 *
 * Pure over its inputs (forward components + the scratch `right` vector it fills)
 * so the basis sign is unit-testable without a live World. Degenerate forward
 * (camera looking straight down, |fwd_xz| ~ 0) falls back to world -Z forward /
 * +X right.
 */
export function planarBasisFromForward(
  fx: number,
  fz: number,
  right: Vec3,
): { fwdX: number; fwdZ: number } {
  const fLen = Math.hypot(fx, fz);
  const fwdX = fLen > 1e-5 ? fx / fLen : 0;
  const fwdZ = fLen > 1e-5 ? fz / fLen : -1;
  right[0] = -fwdZ;
  right[1] = 0;
  right[2] = fwdX;
  return { fwdX, fwdZ };
}

// Extract the camera's planar forward/right in world space from its Transform.
// Falls back to world -z forward / +x right when the camera world mat4 is
// unreadable. The sign math lives in planarBasisFromForward (unit-tested).
function cameraPlanarBasis(
  world: World,
  camera: EntityHandle,
  fwd: Vec3,
  right: Vec3,
): { fwdX: number; fwdZ: number } {
  const camTf = world.get(camera, GlobalTransform);
  if (!camTf.ok) {
    right[0] = 1;
    right[2] = 0;
    return { fwdX: 0, fwdZ: -1 };
  }
  mat4.getForward(fwd, camTf.value.world as unknown as Mat4Like);
  return planarBasisFromForward(fwd[0] ?? 0, fwd[2] ?? 0, right);
}

// Dev-only camera-follow toggle. When false, followCamera leaves the camera
// Transform untouched so a verification harness can pin the camera at a fixed
// wide vantage and read player translation/facing from static screenshots (the
// normal follow centers the player every frame, hiding motion). Production keeps
// this true; only the dev hook in main.ts flips it.
let cameraFollowEnabled = true;
export function setCameraFollowEnabled(enabled: boolean): void {
  cameraFollowEnabled = enabled;
}

// Third-person follow: place the camera at player + fixed orbit offset,
// oriented to look at the player (with a slight upward look-offset to avoid
// staring at feet). The look target is at player position + 1 unit Y so the
// camera frames the torso rather than the ground.
function followCamera(world: World, player: EntityHandle, camera: EntityHandle): void {
  if (!cameraFollowEnabled) return;
  const playerTf = world.get(player, Transform);
  if (!playerTf.ok) return;
  const px = playerTf.value.pos[0] ?? 0;
  const py = playerTf.value.pos[1] ?? 0;
  const pz = playerTf.value.pos[2] ?? 0;
  const look = cameraLookAtQuat(
    px,
    py + CAMERA_OFFSET_Y,
    pz + CAMERA_OFFSET_Z,
    px,
    py + 1, // look at player torso, not feet
    pz,
    0,
    1,
    0, // up = +Y
  );
  world.set(camera, Transform, {
    pos: [px, py + CAMERA_OFFSET_Y, pz + CAMERA_OFFSET_Z],
    quat: look,
  });
}
