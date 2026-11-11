import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import { FixedUpdate, Time, Update, type World } from '@forgeax/engine/ecs';
import { vec3 } from '@forgeax/engine/math';
import type { PhysicsWorld } from '@forgeax/engine/physics';
import type { Plugin } from '@forgeax/engine/plugin';
import { PROPAGATE_TRANSFORMS_SYSTEM, readPresentationWorldMatrix, setTransformLookAt } from '@forgeax/engine/scene';
import type { Game3dPlayerService } from '../shared/player-protocol.ts';
import { integratePointerLook, orbitPosition } from '../shared/third-person.ts';
import { resolveGameEntity } from '../shared/scene-refs.ts';

const CAMERA_DISTANCE = 6.5;
/** The camera looks at this point above the player's origin. */
const CAMERA_TARGET_HEIGHT = 0.5;
/** Exponential follow rates (1/s) for the eye and the look point, like three's `lerp(target, 1 - exp(-k dt))`. */
const EYE_FOLLOW = 10;
const LOOK_FOLLOW = 14;
/** The occlusion ray starts this far out, past the player's own capsule. */
const CAMERA_RAY_START = 0.6;
/** Gap kept between the camera and the collider that would block the view. */
const CAMERA_WALL_MARGIN = 0.3;
const CAMERA_MIN_DISTANCE = 1.2;

/** How far the orbit can extend from `target` before a collider blocks the view. */
function clearDistance(world: World, target: Point, yaw: number, pitch: number): number {
  if (!world.hasResource('PhysicsWorld')) return CAMERA_DISTANCE;
  const far = orbitPosition(target, yaw, pitch, 1);
  const origin = orbitPosition(target, yaw, pitch, CAMERA_RAY_START);
  const hit = world
    .getResource<PhysicsWorld>('PhysicsWorld')
    .raycast(
      vec3.create(origin[0], origin[1], origin[2]),
      vec3.create(far[0] - target[0], far[1] - target[1], far[2] - target[2]),
      CAMERA_DISTANCE - CAMERA_RAY_START,
    );
  if (hit === undefined) return CAMERA_DISTANCE;
  return Math.max(CAMERA_MIN_DISTANCE, CAMERA_RAY_START + hit.timeOfImpact - CAMERA_WALL_MARGIN);
}

type Point = readonly [number, number, number];

function approach(current: number[], target: Point, amount: number): void {
  for (let axis = 0; axis < 3; axis += 1)
    current[axis] = (current[axis] ?? 0) + ((target[axis] ?? 0) - (current[axis] ?? 0)) * amount;
}

/**
 * Third-person follow camera in the three.js style: `eye` (camera position) and
 * `look` (the point it aims at) are two plain points, each eased toward its goal
 * every frame, then written with `setTransformLookAt`. A game changes the camera
 * by changing how those two points move (e.g. hold `eye` and keep `look` on the
 * player while falling); a teleport snaps both.
 */
export const camera: Plugin = {
  name: 'game-3d/camera',
  inject: ['world', 'gameHost', 'game3dPlayer', 'gameScene'],
  apply(ctx) {
    const world = ctx.world;
    const host = ctx.gameHost;
    if (host === undefined) throw new Error('game-3d/camera requires the App-owned GameHost');
    const playerService = ctx.game3dPlayer as Game3dPlayerService | undefined;
    if (playerService === undefined)
      throw new Error('game-3d/camera requires the game-3d/player service');
    const player = playerService.entity;
    const camera = resolveGameEntity(world, ctx.gameScene, 'camera');
    const eye = [0, 0, 0];
    const look = [0, 0, 0];
    let snap = true;
    ctx.effect(function* () {
      // Mouse look: lock the pointer on click. A cursor-aimed game passes false instead.
      host.setPointerLockAllowed?.(true);
      yield () => host.setPointerLockAllowed?.(false);
      yield playerService.onTeleport(() => {
        snap = true;
      });
      world
        .addSystem(Update, {
          name: 'game-3d-camera',
          after: [FixedUpdate, 'game-3d-player-input'],
          before: [PROPAGATE_TRANSFORMS_SYSTEM],
          queries: [],
          fn: () => {
            const input = playerService.readInput();
            const dt = world.getResource(Time).delta;
            const previous = playerService.readLook();
            const { yaw, pitch } = integratePointerLook(previous.yaw, previous.pitch, input.lookX, input.lookY);
            playerService.setLook({ yaw, pitch });
            const playerMatrix = readPresentationWorldMatrix(world, player);
            if (playerMatrix === undefined) throw new Error('game-3d/camera requires the player presentation pose');
            const target: Point = [
              playerMatrix[12] ?? 0,
              (playerMatrix[13] ?? 0) + CAMERA_TARGET_HEIGHT,
              playerMatrix[14] ?? 0,
            ];
            // A collider between the player and the orbit (ground, rock, trunk) puts the eye in
            // front of it at once; it eases back out when the view clears. Meshes without a
            // collider do not block.
            const distance = clearDistance(world, target, yaw, pitch);
            const goal = orbitPosition(target, yaw, pitch, distance);
            approach(eye, goal, snap || distance < CAMERA_DISTANCE ? 1 : 1 - Math.exp(-EYE_FOLLOW * dt));
            approach(look, target, snap ? 1 : 1 - Math.exp(-LOOK_FOLLOW * dt));
            snap = false;
            setTransformLookAt(world, camera, eye, look).unwrap();
          },
        })
        .unwrap();
      yield () => world.removeSystem(Update, 'game-3d-camera').unwrap();
    }, 'game-3d/camera');
  },
};

export default definePack({
  schemaVersion: '2.0.0', plugins: true,
  packageId: definePackageId('019fb7ce-3c00-7000-8000-000000000000'),
  build: () => ok({
    'plugin/camera': {
      kind: 'plugin',
      module: { specifier: './camera.pack.ts', export: 'camera' },
    },
  }),
});
