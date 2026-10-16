import { Collider, ColliderShapeValue, CollidingEntities, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { FixedTime, FixedUpdate, type CommandBuffer, type ComponentData, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { Layer, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { SpriteAnimation, SpriteRegionOverride, SpritePlayback } from '@forgeax/engine-render/authoring';
import { quat, type Handle } from '@forgeax/engine-runtime';
import type { InputSnapshot } from '@forgeax/engine-input';
import { inState } from '@forgeax/engine-state';
import type { CustomProjectileMesh } from '../custom-projectile-mesh';
import type { SpriteAtlasLoop } from '../sprite-atlas-loop';
import { GameState } from '../gameplay-state';
import {
  ChargeShot,
  GameplayInput,
  PlayerMotion,
  Projectile,
  PROJECTILE_ALLEGIANCE_HOSTILE,
  PROJECTILE_ALLEGIANCE_PLAYER,
  type ProjectileAllegiance,
  type ProjectileVisual,
} from '../components/gameplay';
import { DamageHazard } from '../counterattack';
import { GAME_DEFAULT_GAMEPLAY_CONFIG, type GameplayConfig } from '../resources/gameplay';
import type { RewardChoiceHandle } from '../reward-choice';
import type { AttackPresentationHandle } from './attack-presentation';

export const OVERCHARGE_IMPACT_MULTIPLIER = 2;

export type SharedProjectileSpawn = {
  readonly source: EntityHandle;
  readonly allegiance: ProjectileAllegiance;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: number;
  readonly velocity: readonly [number, number, number];
  readonly life: number;
  readonly impactScale: number;
  readonly presentationVariant?: number;
  readonly radius: number;
  readonly halfHeight: number;
  readonly mesh: Handle<'MeshAsset', 'shared'>;
  readonly material: Handle<'MaterialAsset', 'shared'>;
  readonly layer?: number;
  readonly presentation?: readonly ComponentData[];
};

/** The only player/hostile projectile construction path. */
export function spawnSharedProjectile(commands: CommandBuffer, shot: SharedProjectileSpawn): EntityHandle {
  const components: ComponentData[] = [
    { component: Transform, data: { pos: [...shot.position], quat: [...shot.rotation], scale: [shot.scale, shot.scale, shot.scale] } },
    { component: MeshFilter, data: { assetHandle: shot.mesh } },
    { component: MeshRenderer, data: { materials: [shot.material] } },
    { component: Layer, data: { value: shot.layer ?? 0 } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic, ccdEnabled: true } },
    { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: shot.radius, halfHeight: shot.halfHeight, friction: 0, restitution: 0.6 } },
    { component: CollidingEntities, data: { entities: [] } },
    {
      component: Projectile,
      data: {
        age: 0,
        velocityX: shot.velocity[0],
        velocityY: shot.velocity[1],
        velocityZ: shot.velocity[2],
        life: shot.life,
        impactScale: shot.impactScale,
        presentationVariant: shot.presentationVariant ?? 0,
        source: shot.source,
        allegiance: shot.allegiance === 'hostile' ? PROJECTILE_ALLEGIANCE_HOSTILE : PROJECTILE_ALLEGIANCE_PLAYER,
      },
    },
  ];
  if (shot.allegiance === 'hostile') components.push({ component: DamageHazard, data: {} });
  components.push(...(shot.presentation ?? []));
  return commands.spawn(...components);
}

export type ProjectileSpawnDecision = {
  readonly spawned: boolean;
  readonly impactScale: number;
  readonly consumeOvercharge: boolean;
};

export function resolveProjectileSpawn(input: {
  readonly normalFire: boolean;
  readonly chargedFire: boolean;
  readonly cooldown: number;
  readonly chargePower: number;
  readonly overchargeReady: boolean;
}): ProjectileSpawnDecision {
  const spawned = (input.normalFire || input.chargedFire) && input.cooldown <= 0;
  if (!spawned) return { spawned: false, impactScale: 1, consumeOvercharge: false };
  if (!input.chargedFire) return { spawned: true, impactScale: 1, consumeOvercharge: false };
  const consumeOvercharge = input.overchargeReady;
  return {
    spawned: true,
    impactScale: Math.max(1, input.chargePower) * (consumeOvercharge ? OVERCHARGE_IMPACT_MULTIPLIER : 1),
    consumeOvercharge,
  };
}

export type ProjectileSimulationSystemContext = {
  readonly world: World;
  readonly root: EntityHandle;
  readonly readInput: () => InputSnapshot;
  readonly getMode: () => 'topdown' | 'orbit' | 'fps' | 'pan';
  readonly getProjectileVisual: () => ProjectileVisual;
  readonly customProjectile: CustomProjectileMesh | undefined;
  readonly spriteAtlasLoop: SpriteAtlasLoop | undefined;
  readonly projectileMesh: Handle<'MeshAsset', 'shared'>;
  readonly projectileMaterial: Handle<'MaterialAsset', 'shared'>;
  readonly handleQuad: Handle<'MeshAsset', 'shared'>;
  readonly projectileEntities: () => readonly EntityHandle[];
  readonly rewardChoice: RewardChoiceHandle | undefined;
  readonly attackPresentation: AttackPresentationHandle | undefined;
  readonly onSpawn: (overcharged: boolean) => void;
  readonly consumeProjectile: (entity: EntityHandle) => void;
};

/** Spawns and advances projectiles from ECS-owned Projectile + Transform state. */
export function installProjectileSimulationSystem(ctx: ProjectileSimulationSystemContext): void {
  ctx.world.addSystem(FixedUpdate, {
    name: 'game-projectile-simulation',
    runIf: inState(GameState, 'Play'),
    after: ['game-player-movement'],
    queries: [],
    fn: (_world, _queryResults, commands) => {
      const dt = ctx.world.getResource(FixedTime).delta;
      const config = ctx.world.getResource<GameplayConfig>(GAME_DEFAULT_GAMEPLAY_CONFIG);
      const snap = ctx.readInput();
      const playerTransform = ctx.world.get(ctx.root, Transform);
      const playerMotion = ctx.world.get(ctx.root, PlayerMotion);
      const gameplayInput = ctx.world.get(ctx.root, GameplayInput);
      const charge = ctx.world.get(ctx.root, ChargeShot);
      if (!playerTransform.ok || !playerMotion.ok || !gameplayInput.ok || !charge.ok) return;
      const px = playerTransform.value.pos[0] ?? 0;
      const pz = playerTransform.value.pos[2] ?? 0;
      const jumpY = playerMotion.value.jumpY;
      const freeY = playerMotion.value.freeY;
      const faceX = playerMotion.value.faceX;
      const faceZ = playerMotion.value.faceZ;
      let shootCd = playerMotion.value.shootCooldown - dt;
      const playerY = ctx.getMode() === 'fps' ? freeY : jumpY;
      const chargedFire = charge.value.release !== 0;
      const normalFire = charge.value.active === 0 && (snap.action('shoot').isPressed() || gameplayInput.value.wantShoot !== 0);
      const spawnDecision = resolveProjectileSpawn({
        normalFire,
        chargedFire,
        cooldown: shootCd,
        chargePower: charge.value.power,
        overchargeReady: ctx.rewardChoice?.snapshot().state === 'overcharge-ready',
      });
      ctx.world.set(ctx.root, GameplayInput, { wantShoot: 0 });
      if (spawnDecision.spawned) {
        shootCd = config.projectile.shootCooldown;
        let dirX = faceX;
        let dirY = 0;
        let dirZ = faceZ;
        let by = playerY + 0.15;
        if (ctx.getMode() === 'fps') {
          const cp = Math.cos(gameplayInput.value.lookPitch);
          dirX = -Math.sin(gameplayInput.value.lookYaw) * cp;
          dirY = Math.sin(gameplayInput.value.lookPitch);
          dirZ = -Math.cos(gameplayInput.value.lookYaw) * cp;
          by = freeY + config.camera.eyeHeight;
        } else if (gameplayInput.value.shotDirValid !== 0) {
          dirX = gameplayInput.value.shotDirX;
          dirZ = gameplayInput.value.shotDirZ;
        }
        ctx.world.set(ctx.root, GameplayInput, { shotDirValid: 0 });
        const bx = px + dirX * 0.6;
        const byy = by + dirY * 0.6;
        const bz = pz + dirZ * 0.6;
        const impactScale = spawnDecision.impactScale;
        const shotScale = 1 + (impactScale - 1) * 0.6;
        const bulletQuat = quat.fromUnitVectors(quat.create(), [0, 1, 0], [dirX, dirY, dirZ]);
        const visual = ctx.getProjectileVisual();
        const useSprite = visual !== 'mesh' && ctx.customProjectile !== undefined;
        const atlasActive = ctx.spriteAtlasLoop?.active === true;
        const shotMesh = useSprite ? ctx.handleQuad : ctx.projectileMesh;
        const shotMaterial = atlasActive
          ? visual === 'sprite-lit'
            ? ctx.spriteAtlasLoop!.spriteLitMaterialHandle
            : ctx.spriteAtlasLoop!.spriteMaterialHandle
          : visual === 'sprite-lit'
            ? ctx.customProjectile!.spriteLitMaterialHandle
            : visual === 'sprite'
              ? ctx.customProjectile!.spriteMaterialHandle
              : ctx.projectileMaterial;
        const spriteAnimationComponents = atlasActive
          ? [
            { component: SpriteAnimation, data: { frameCount: ctx.spriteAtlasLoop!.frameCount, frameDuration: ctx.spriteAtlasLoop!.frameDuration, regions: new Float32Array(ctx.spriteAtlasLoop!.regions), playbackMode: SpritePlayback.loop } },
            { component: SpriteRegionOverride, data: { region: new Float32Array(ctx.spriteAtlasLoop!.regions.slice(0, 4)) } },
          ]
          : [];
        const entity = spawnSharedProjectile(commands, {
          source: ctx.root,
          allegiance: 'player',
          position: [bx, byy, bz],
          rotation: [bulletQuat[0]!, bulletQuat[1]!, bulletQuat[2]!, bulletQuat[3]!],
          scale: shotScale,
          velocity: [dirX * config.projectile.speed, dirY * config.projectile.speed, dirZ * config.projectile.speed],
          life: config.projectile.life,
          impactScale,
          presentationVariant: spawnDecision.consumeOvercharge ? 1 : 0,
          radius: config.projectile.radius,
          halfHeight: config.projectile.halfHeight,
          mesh: shotMesh,
          material: shotMaterial,
          layer: useSprite ? 100 : 0,
          presentation: [
            ...(ctx.attackPresentation?.projectilePresentation() ?? []),
            ...spriteAnimationComponents,
          ],
        });
        if (spawnDecision.consumeOvercharge) ctx.rewardChoice?.consumeOvercharge();
        if (atlasActive) ctx.spriteAtlasLoop?.track(entity);
        if (chargedFire) ctx.world.set(ctx.root, ChargeShot, { release: 0 });
        ctx.attackPresentation?.onSpawn(spawnDecision.consumeOvercharge);
        ctx.onSpawn(spawnDecision.consumeOvercharge);
      }
      for (const entity of ctx.projectileEntities()) {
        const transform = ctx.world.get(entity, Transform);
        const projectile = ctx.world.get(entity, Projectile);
        if (!transform.ok || !projectile.ok) continue;
        const age = projectile.value.age + dt;
        if (age > projectile.value.life) {
          ctx.attackPresentation?.onExpired(entity);
          ctx.consumeProjectile(entity);
          continue;
        }
        ctx.world.set(entity, Transform, {
          pos: [
            (transform.value.pos[0] ?? 0) + projectile.value.velocityX * dt,
            (transform.value.pos[1] ?? 0) + projectile.value.velocityY * dt,
            (transform.value.pos[2] ?? 0) + projectile.value.velocityZ * dt,
          ],
        });
        ctx.world.set(entity, Projectile, { age });
      }
      ctx.world.set(ctx.root, PlayerMotion, { shootCooldown: shootCd });
    },
  }).unwrap();
}
