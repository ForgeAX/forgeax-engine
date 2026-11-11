import { ADVANCE_ANIMATION_PLAYER_SYSTEM, AnimatedBy, AnimationPlayer, AnimationTargetId, bindAnimationTargets, defineAnimationMask, deriveAnimationTargetId } from '@forgeax/engine/animation';
import {
  defineComponent,
  FixedTime,
  Time,
  FixedUpdate,
  Update,
  type EntityHandle,
  type World,
} from '@forgeax/engine/ecs';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { quat, vec3 } from '@forgeax/engine/math';
import { CharacterController, type PhysicsWorld } from '@forgeax/engine/physics';
import type { Plugin } from '@forgeax/engine/plugin';
import { resetTransformInterpolation, Transform } from '@forgeax/engine/scene';
import { cameraRelativeMove, facingYaw } from '../shared/third-person.ts';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { resolveGameEntity, type GameScene } from '../shared/scene-refs.ts';
import {
  CONVOY_WHEELS, PLAYER_JOINT_NAMES, PLAYER_RIG, PLAYER_TRANSFORM_SECONDS, PLAYER_WALK_SECONDS,
  PLAYER_WHEEL_RADIUS, playerTargetPath,
} from '../shared/player-rig.ts';
import {
  PLAYER_STATE_CHANNEL, type Game3dPlayerService, type PlayerHudState, type PlayerInput,
} from '../shared/player-protocol.ts';
import { createPlayerInput } from './player-input.ts';

export const ThirdPersonRig = defineComponent(
  'Game3dThirdPersonRig',
  {
    verticalVelocity: { type: 'f32', default: 0 },
    vehicleSpeed: { type: 'f32', default: 0 },
    yaw: { type: 'f32', default: 0 },
    pitch: { type: 'f32', default: (20 * Math.PI) / 180 },
    facingX: { type: 'f32', default: 0 },
    facingZ: { type: 'f32', default: -1 },
  },
  { transient: true },
);

type SceneHost = NonNullable<import('@forgeax/engine/app').GameHost>;

interface PlayerConfig {
  readonly speed: number;
  readonly jumpSpeed: number;
  readonly gravity: number;
  readonly walk: string;
  readonly transform: string;
  readonly wheels: string;
}
const playerPlugin: Plugin.Object<PlayerConfig> = {
  name: 'game-3d/player',
  provide: 'game3dPlayer',
  inject: ['world', 'physics', 'gameHost', 'gameScene'],
  async apply(ctx, config) {
    const world = ctx.world;
    const host = ctx.gameHost;
    if (host === undefined) throw new Error('game-3d/player requires the App-owned GameHost');
    const readDrawingBufferSize = host.drawingBufferSize?.bind(host);
    const player = resolveGameEntity(world, ctx.gameScene, 'player');
    await ctx.effect(async function* () {
      const sampleInput = createPlayerInput();
      let frameInput: PlayerInput = { horizontal: 0, vertical: 0, lookX: 0, lookY: 0, run: false };
      const receive = (event: MessageEvent) => sampleInput.receive(event.data);
      host.port?.addEventListener('message', receive);
      host.port?.start();
      yield () => {
        host.port?.removeEventListener('message', receive);
        sampleInput.reset();
      };
      const lease = world.components.register(ThirdPersonRig).unwrap();
      yield () => lease.dispose().unwrap();
      world
        .addComponent(player, { component: ThirdPersonRig, data: {} })
        .unwrap();
      yield () => world.removeComponent(player, ThirdPersonRig).unwrap();
      const teleportListeners = new Set<() => void>();
      const playerService: Game3dPlayerService = {
        entity: player,
        readInput: () => frameInput,
        readLook: () => {
          const rig = world.get(player, ThirdPersonRig).unwrap();
          return { yaw: rig.yaw, pitch: rig.pitch };
        },
        setLook: (look) => {
          world.set(player, ThirdPersonRig, { yaw: look.yaw, pitch: look.pitch }).unwrap();
        },
        teleport: (position) => {
          const physics = world.getResource<PhysicsWorld>('PhysicsWorld');
          physics.teleport(player, vec3.create(position[0], position[1], position[2]));
          world.set(player, ThirdPersonRig, { verticalVelocity: 0 }).unwrap();
          resetTransformInterpolation(world, player);
          for (const listener of teleportListeners) listener();
        },
        onTeleport: (listener) => {
          teleportListeners.add(listener);
          return () => teleportListeners.delete(listener);
        },
      };
      let vehicle = false, transformProgress = 0, wheelTime = 0;
      yield* installCharacterAnimation(world, host, ctx.gameScene, player, [config.walk, config.transform, config.wheels]);
      world.addSystem(Update, {
        name: 'game-3d-player-input',
        after: [FRAME_START_SCAN_SYSTEM_NAME],
        before: [FixedUpdate, ADVANCE_ANIMATION_PLAYER_SYSTEM],
        queries: [],
        fn: () => {
          const size = readDrawingBufferSize?.();
          frameInput = sampleInput.sample(
            world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY),
            size?.width ?? 0, size?.height ?? 0,
          );
          // Visual playback consumes this frame's input even when no fixed
          // step runs. Physics alone consumes the fixed-step movement delta.
          if (sampleInput.takeTransform()) vehicle = !vehicle;
          const dt = world.getResource(Time).delta;
          const previousProgress = transformProgress;
          transformProgress = Math.max(0, Math.min(1, transformProgress + (vehicle ? 1 : -1) * dt / PLAYER_TRANSFORM_SECONDS));
          const moving = Math.hypot(frameInput.horizontal, frameInput.vertical) > 0.001;
          const walkWeight = moving && transformProgress === 0 && previousProgress === 0 ? 1 : 0;
          const animation = world.get(player, AnimationPlayer).unwrap();
          wheelTime = (wheelTime + dt * world.get(player, ThirdPersonRig).unwrap().vehicleSpeed / (2 * Math.PI * PLAYER_WHEEL_RADIUS)) % 1;
          if (wheelTime < 0) wheelTime += 1;
          world.set(player, AnimationPlayer, {
            weights: [walkWeight, 1 - walkWeight, 1],
            times: [((animation.times[0] ?? 0) + dt) % PLAYER_WALK_SECONDS, transformProgress * PLAYER_TRANSFORM_SECONDS, wheelTime],
          }).unwrap();
        },
      }).unwrap();
      yield () => world.removeSystem(Update, 'game-3d-player-input').unwrap();
      // Engine -> UI: the HUD only receives a small rounded snapshot, and only when it changes.
      // Speed comes from the displacement physics actually applied in the last fixed step,
      // so it is stable regardless of render frame rate and fixed-step count per frame.
      const motion = { planarSpeed: 0 };
      let lastHud = '';
      world.addSystem(Update, {
        name: 'game-3d-player-hud',
        after: [FixedUpdate, 'game-3d-player-input'],
        queries: [],
        fn: () => {
          const pos = world.get(player, Transform).unwrap().pos;
          const controller = world.get(player, CharacterController);
          const state: PlayerHudState = {
            height: Math.round((pos[1] ?? 0) * 10) / 10,
            speed: Math.round(motion.planarSpeed * 10) / 10,
            grounded: controller.ok ? controller.value.grounded : true,
            running: frameInput.run,
          };
          const key = JSON.stringify(state);
          if (key === lastHud) return;
          lastHud = key;
          host.port?.postMessage({ channel: PLAYER_STATE_CHANNEL, state });
        },
      }).unwrap();
      yield () => world.removeSystem(Update, 'game-3d-player-hud').unwrap();
      installMovement(world, player, config, playerService.readInput, sampleInput.takeJump, () => transformProgress, motion);
      yield () => world.removeSystem(FixedUpdate, 'game-3d-player-movement').unwrap();
      const unregisterRead = host.gameProjection?.registerRead({
        id: 'game-3d.player',
        title: 'Third-person player state',
        description: 'Resolved physics position, camera angles, facing, and grounded state.',
        read: () => {
          const transform = world.get(player, Transform).unwrap();
          const rig = world.get(player, ThirdPersonRig).unwrap();
          const controller = world.get(player, CharacterController).unwrap();
          const animation = world.get(player, AnimationPlayer).unwrap();
          const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
          return {
            position: Array.from(transform.pos),
            facing: [rig.facingX, rig.facingZ],
            camera: { yaw: rig.yaw, pitch: rig.pitch, pointerLocked: input.mouse.pointerLocked },
            grounded: controller.grounded, vehicleSpeed: rig.vehicleSpeed,
            mode: transformProgress === 0 ? 'robot' : transformProgress === 1 ? 'truck' : 'transforming',
            transformProgress, transformSeconds: PLAYER_TRANSFORM_SECONDS, vehicleRequested: vehicle, wheelTime,
            pose: {
              headRetraction: ['HeadSlideBase', 'HeadSlide'].reduce((sum, joint) => sum - world.get(resolveGameEntity(world, ctx.gameScene, `player/joint/${joint}`), Transform).unwrap().pos[1]!, 0),
              thighRotationX: world.get(resolveGameEntity(world, ctx.gameScene, 'player/joint/Thigh.L'), Transform).unwrap().quat[0]!,
            },
            controls: { horizontal: frameInput.horizontal, vertical: frameInput.vertical, run: frameInput.run },
            simulation: { fixedTick: world.getResource(FixedTime).tick },
            animation: { walkWeight: animation.weights[0] ?? 0, walkTime: animation.times[0] ?? 0 },
          };
        },
      });
      if (unregisterRead !== undefined) yield unregisterRead;
      ctx.provide('game3dPlayer', playerService);
    }, 'game-3d/player');
  },
};

export default playerPlugin;

async function* installCharacterAnimation(
  world: World,
  host: SceneHost,
  scene: GameScene,
  player: EntityHandle,
  clips: readonly string[],
): AsyncGenerator<() => void, void, void> {
  const loadedClips = [];
  for (const guid of clips) {
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) throw parsed.error;
    const loaded = await host.assets.load(parsed.value, 'animation-clip');
    if (!loaded.ok) throw loaded.error;
    loadedClips.push(loaded.value);
    yield () => { host.assets.release(loaded.value).unwrap(); };
  }
  const wheelNames = new Set(CONVOY_WHEELS.map(wheel => wheel.name));
  const maskFor = (wheels: boolean) => world.allocSharedRef('AnimationMask', defineAnimationMask(
    PLAYER_RIG.flatMap((joint, index) => wheelNames.has(joint.name) === wheels ? [{ targetId: deriveAnimationTargetId(playerTargetPath(index)), weight: 1 }] : []),
  ).unwrap());
  const bodyMask = maskFor(false);
  yield () => { world.sharedRefs.release(bodyMask).unwrap(); };
  const wheelMask = maskFor(true);
  yield () => { world.sharedRefs.release(wheelMask).unwrap(); };
  world
    .addComponent(player, {
      component: AnimationPlayer,
      data: { clips: loadedClips, times: [0, 0, 0], weights: [0, 1, 1], speeds: [0, 0, 0], looping: false, masks: [bodyMask, bodyMask, wheelMask] },
    })
    .unwrap();
  yield () => {
    world.removeComponent(player, AnimationPlayer).unwrap();
  };
  const targets = PLAYER_JOINT_NAMES.map((name) =>
    resolveGameEntity(world, scene, `player/joint/${name}`),
  );
  // Binding can add IDs and relationships to borrowed scene entities. Only
  // remove the contributions introduced here, including a partial bind.
  const newIds = targets.filter((target) => !world.get(target, AnimationTargetId).ok);
  const newBindings = targets.filter((target) => !world.get(target, AnimatedBy).ok);
  yield () => {
    for (const target of newBindings) {
      if (world.get(target, AnimatedBy).ok) world.removeComponent(target, AnimatedBy).unwrap();
    }
    for (const target of newIds) {
      if (world.get(target, AnimationTargetId).ok)
        world.removeComponent(target, AnimationTargetId).unwrap();
    }
  };
  const bound = bindAnimationTargets(world, player, targets);
  if (!bound.ok) throw bound.error;
}

function vehicleMotion(dt: number, speed: number, horizontal: number, vertical: number,
  rig: { readonly vehicleSpeed: number; readonly facingX: number; readonly facingZ: number }) {
  const targetSpeed = vertical * speed * (vertical < 0 ? 0.45 : 1);
  const acceleration = (vertical === 0 ? 12 : 8) * dt;
  const vehicleSpeed = rig.vehicleSpeed + Math.max(-acceleration, Math.min(acceleration, targetSpeed - rig.vehicleSpeed));
  const yaw = facingYaw(rig.facingX, rig.facingZ) - horizontal * dt * 1.5 * Math.min(1, Math.abs(vehicleSpeed) / 3) * Math.sign(vehicleSpeed);
  const move = { x: -Math.sin(yaw), z: -Math.cos(yaw), length: Math.abs(vehicleSpeed) > 0.001 ? 1 : 0 };
  return { move, vehicleSpeed, distance: vehicleSpeed * dt };
}

function planarSpeed(applied: ArrayLike<number>, dt: number): number {
  return Math.hypot(applied[0] ?? 0, applied[2] ?? 0) / dt;
}

function installMovement(
  world: World, player: EntityHandle, config: PlayerConfig,
  readInput: () => PlayerInput, takeJump: () => boolean, readTransform: () => number,
  motion: { planarSpeed: number },
): void {
  world
    .addSystem(FixedUpdate, {
      name: 'game-3d-player-movement',
      queries: [],
      fn: () => {
        if (!world.hasResource('PhysicsWorld')) return;
        const physics = world.getResource<PhysicsWorld>('PhysicsWorld');
        if (!physics.hasBody(player)) return;
        const dt = world.getResource(FixedTime).delta;
        const rig = world.get(player, ThirdPersonRig).unwrap();
        const controller = world.get(player, CharacterController).unwrap();
        const { horizontal, vertical, run } = readInput();
        const jump = takeJump();
        const progress = readTransform();
        const speed = config.speed * (run ? 1.7 : 1) * (1 + progress * 1.25);
        let move = cameraRelativeMove(rig.yaw, horizontal, vertical);
        let vehicleSpeed = 0;
        let distance = speed * dt;
        if (progress > 0 && progress < 1) { move = { x: 0, z: 0, length: 0 }; distance = 0; }
        if (progress === 1) {
          ({ move, vehicleSpeed, distance } = vehicleMotion(dt, speed, horizontal, vertical, rig));
        }
        let verticalVelocity = rig.verticalVelocity;
        if (controller.grounded && jump && progress === 0)
          verticalVelocity = config.jumpSpeed;
        verticalVelocity -= config.gravity * dt;
        if (controller.grounded && verticalVelocity < 0) verticalVelocity = -config.gravity * dt;
        const applied = physics.moveAndSlide(
          player,
          vec3.create(
            move.x * distance,
            verticalVelocity * dt,
            move.z * distance,
          ),
        );
        motion.planarSpeed = planarSpeed(applied, dt);
        if (world.get(player, CharacterController).unwrap().grounded && verticalVelocity < 0)
          verticalVelocity = 0;
        if (move.length > 0.001) {
          const rotation = quat.eulerY(facingYaw(move.x, move.z));
          world
            .set(player, Transform, {
              quat: [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1],
            })
            .unwrap();
        }
        world
          .set(player, ThirdPersonRig, {
            verticalVelocity, vehicleSpeed,
            ...(move.length > 0.001 ? { facingX: move.x, facingZ: move.z } : {}),
          })
          .unwrap();
      },
    })
    .unwrap();
}
