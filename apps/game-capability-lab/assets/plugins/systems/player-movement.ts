import { CharacterController, type PhysicsWorld } from '@forgeax/engine-physics';
import { FixedTime, FixedUpdate, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import type { InputSnapshot } from '@forgeax/engine-input';
import { quat } from '@forgeax/engine-runtime';
import { vec3 } from '@forgeax/engine-math';
import { inState } from '@forgeax/engine-state';
import { resetFreeCamera, stepFreeCamera, type FreeCameraState } from '../free-camera';
import { GameState } from '../gameplay-state';
import { FreeCameraMotion, GameplayInput, PlayerMotion } from '../components/gameplay';
import { GAME_DEFAULT_GAMEPLAY_CONFIG, type GameplayConfig } from '../resources/gameplay';

export type PlayerMovementSystemContext = {
  readonly world: World;
  readonly root: EntityHandle;
  readonly readInput: () => InputSnapshot;
  readonly getMode: () => 'topdown' | 'orbit' | 'fps' | 'pan';
  readonly physics: PhysicsWorld | undefined;
};

/** Owns player intent, CharacterController integration, and ECS pose writes. */
export function installPlayerMovementSystem(ctx: PlayerMovementSystemContext): void {
  ctx.world.addSystem(FixedUpdate, {
    name: 'game-player-movement',
    runIf: inState(GameState, 'Play'),
    queries: [],
    fn: () => {
      const dt = ctx.world.getResource(FixedTime).delta;
      const config = ctx.world.getResource<GameplayConfig>(GAME_DEFAULT_GAMEPLAY_CONFIG);
      const snap = ctx.readInput();
      const motionResult = ctx.world.get(ctx.root, PlayerMotion);
      const transformResult = ctx.world.get(ctx.root, Transform);
      const freeMotionResult = ctx.world.get(ctx.root, FreeCameraMotion);
      const inputResult = ctx.world.get(ctx.root, GameplayInput);
      if (!motionResult.ok || !transformResult.ok || !freeMotionResult.ok || !inputResult.ok) return;
      let jumpY = motionResult.value.jumpY;
      let freeY = motionResult.value.freeY;
      let vy = motionResult.value.velocityY;
      let grounded = motionResult.value.grounded !== 0;
      let faceX = motionResult.value.faceX;
      let faceZ = motionResult.value.faceZ;
      let px = transformResult.value.pos[0] ?? 0;
      let pz = transformResult.value.pos[2] ?? 0;
      const freeCamera: FreeCameraState = {
        velocityX: freeMotionResult.value.velocityX,
        velocityY: freeMotionResult.value.velocityY,
        velocityZ: freeMotionResult.value.velocityZ,
        walkSpeed: freeMotionResult.value.walkSpeed,
        runSpeed: freeMotionResult.value.runSpeed,
      };
      const arrowUp = snap.action('arrowUp').isPressed();
      const arrowDown = snap.action('arrowDown').isPressed();
      const arrowLeft = snap.action('arrowLeft').isPressed();
      const arrowRight = snap.action('arrowRight').isPressed();
      const mode = ctx.getMode();
      const am = mode === 'topdown';
      const move = snap.getVector('moveLeft', 'moveRight', 'moveBack', 'moveForward');
      const f = move.y + (am ? ((arrowUp ? 1 : 0) - (arrowDown ? 1 : 0)) : 0);
      const s = move.x + (am ? ((arrowRight ? 1 : 0) - (arrowLeft ? 1 : 0)) : 0);
      let mvx = 0;
      let mvz = 0;
      if (mode !== 'fps') {
        freeY = jumpY;
        resetFreeCamera(freeCamera);
      }
      if (mode === 'fps') {
        const fwdX = -Math.sin(inputResult.value.lookYaw);
        const fwdZ = -Math.cos(inputResult.value.lookYaw);
        const rgtX = -fwdZ;
        const rgtZ = fwdX;
        faceX = fwdX;
        faceZ = fwdZ;
        const vertical = Number(snap.action('freeUp').isPressed()) - Number(snap.action('freeDown').isPressed());
        const delta = stepFreeCamera(freeCamera, dt, [fwdX * f + rgtX * s, vertical, fwdZ * f + rgtZ * s], snap.action('freeRun').isPressed(), snap.mouse.wheelDelta);
        px = Math.max(-config.movement.bound, Math.min(config.movement.bound, px + (delta[0] ?? 0)));
        pz = Math.max(-config.movement.bound, Math.min(config.movement.bound, pz + (delta[2] ?? 0)));
        freeY = Math.max(0.2, freeY + (delta[1] ?? 0));
      } else {
        mvx = s;
        mvz = -f;
        if (mvx !== 0 || mvz !== 0) {
          const length = Math.hypot(mvx, mvz);
          faceX = mvx / length;
          faceZ = mvz / length;
        }
      }

      if (mode !== 'fps' && ctx.physics?.hasBody(ctx.root)) {
        const before = ctx.world.get(ctx.root, CharacterController);
        grounded = before.ok && before.value.grounded === true;
        if (snap.action('jump').justPressed() && grounded) {
          vy = config.movement.jumpVelocity;
          grounded = false;
        }
        vy -= config.movement.gravity * dt;
        if (grounded && vy < 0) vy = -config.movement.gravity * dt;
        const length = Math.hypot(mvx, mvz) || 1;
        ctx.physics.moveAndSlide(ctx.root, vec3.create((mvx / length) * config.movement.speed * dt, vy * dt, (mvz / length) * config.movement.speed * dt));
        const tr = ctx.world.get(ctx.root, Transform);
        if (tr.ok) {
          px = Math.max(-config.movement.bound, Math.min(config.movement.bound, tr.value.pos[0] ?? px));
          pz = Math.max(-config.movement.bound, Math.min(config.movement.bound, tr.value.pos[2] ?? pz));
          jumpY = tr.value.pos[1] ?? jumpY;
        }
        const after = ctx.world.get(ctx.root, CharacterController);
        grounded = after.ok && after.value.grounded === true;
        if (grounded) vy = 0;
      } else if (mode !== 'fps') {
        jumpY = config.movement.playerY;
      } else if (ctx.physics?.hasBody(ctx.root)) {
        ctx.physics.teleport(ctx.root, vec3.create(px, freeY, pz));
      }

      const yaw = Math.atan2(-faceX, -faceZ);
      const q = quat.eulerY(yaw);
      if (mode === 'fps') {
        ctx.world.set(ctx.root, Transform, { pos: [px, freeY, pz], quat: [q[0]!, q[1]!, q[2]!, q[3]!] });
      } else {
        ctx.world.set(ctx.root, Transform, { quat: [q[0]!, q[1]!, q[2]!, q[3]!] });
      }
      ctx.world.set(ctx.root, PlayerMotion, { faceX, faceZ, jumpY, freeY, velocityY: vy, grounded: grounded ? 1 : 0 });
      ctx.world.set(ctx.root, FreeCameraMotion, freeCamera);
    },
  }).unwrap();
}
