import {
  Disabled,
  FixedTime,
  FixedUpdate,
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { CollidingEntities, type PhysicsWorld } from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-scene';
import { inState } from '@forgeax/engine-state';
import { ResetPose } from './components/gameplay';
import { GameState } from './gameplay-state';
import type { RewardChoiceHandle } from './reward-choice';

export const PLAYER_MAX_HEALTH = 3;
export const COUNTERATTACK_COOLDOWN_SECONDS = 1.2;

export type CounterattackPressureTier = 0 | 1 | 2 | 3;

export type CounterattackPressure = {
  readonly tier: CounterattackPressureTier;
  readonly patrolSpeed: number;
  readonly chaseSpeed: number;
  readonly pursuitRadius: number;
};

/** Tier 0 preserves the authored baseline; tier 3 chase remains below 1.5x baseline. */
export const COUNTERATTACK_PRESSURE_TABLE = [
  { patrolSpeed: 1.3, chaseSpeed: 2.15, pursuitRadius: 10 },
  { patrolSpeed: 1.45, chaseSpeed: 2.45, pursuitRadius: 11 },
  { patrolSpeed: 1.6, chaseSpeed: 2.75, pursuitRadius: 12 },
  { patrolSpeed: 1.75, chaseSpeed: 3.15, pursuitRadius: 13 },
] as const;

export function deriveCounterattackPressure(collected: number): CounterattackPressure {
  const tier = Math.max(0, Math.min(3, Math.floor(collected))) as CounterattackPressureTier;
  return { tier, ...COUNTERATTACK_PRESSURE_TABLE[tier] };
}

/** The real player is the sole carrier of counterattack health. */
export const PlayerHealth = defineComponent('GameDefaultPlayerHealth', {
  current: { type: 'u32', default: PLAYER_MAX_HEALTH },
  max: { type: 'u32', default: PLAYER_MAX_HEALTH },
}, { transient: true });

/** Per-attacker chase state on the authored BouncyBall. */
export const BouncyBallHazard = defineComponent('GameDefaultBouncyBallHazard', {
  mode: { type: 'u32', default: 0 },
  patrolAngle: { type: 'f32', default: 0 },
}, { transient: true });

/** Shared admission state for every real-contact source that can damage the player. */
export const DamageHazard = defineComponent('GameDefaultDamageHazard', {
  cooldown: { type: 'f32', default: 0 },
  acceptedHits: { type: 'u32', default: 0 },
}, { transient: true });

export type CounterattackContact = {
  readonly health: number;
  readonly cooldown: number;
  readonly shieldReady?: boolean;
};

export type CounterattackContactResult = CounterattackContact & {
  readonly admitted: boolean;
  readonly defeated: boolean;
  readonly shieldConsumed: boolean;
};

export function resolveCounterattackContact(contact: CounterattackContact): CounterattackContactResult {
  if (contact.cooldown > 0 || contact.health <= 0) {
    return {
      health: contact.health,
      cooldown: contact.cooldown,
      admitted: false,
      defeated: contact.health <= 0,
      shieldConsumed: false,
    };
  }
  const shieldConsumed = contact.shieldReady === true;
  const health = shieldConsumed ? contact.health : Math.max(0, contact.health - 1);
  return {
    health,
    cooldown: COUNTERATTACK_COOLDOWN_SECONDS,
    admitted: true,
    defeated: !shieldConsumed && health === 0,
    shieldConsumed,
  };
}

export type CounterattackSnapshot = {
  readonly playerHealth: number;
  readonly playerMaxHealth: number;
  readonly playerPosition: readonly [number, number, number];
  readonly hazardEntity: number | null;
  readonly hazardActive: boolean;
  readonly hazardMode: 'patrol' | 'chase' | 'disabled' | 'unavailable';
  readonly hazardPosition: readonly [number, number, number] | null;
  readonly pressureTier: CounterattackPressureTier;
  readonly patrolSpeed: number;
  readonly chaseSpeed: number;
  readonly pursuitRadius: number;
  readonly cooldown: number;
  readonly acceptedHits: number;
  readonly lastShieldedHealth: number | null;
};

export type CounterattackHandle = {
  readonly arm: () => boolean;
  readonly admitDamage: (roles: {
    readonly hazardEntity: EntityHandle;
    readonly feedbackEntity: EntityHandle;
  }) => CounterattackContactResult;
  readonly reset: () => void;
  readonly snapshot: () => CounterattackSnapshot;
  readonly installSystem: (ctx: CounterattackSystemContext) => void;
};

type CounterattackSystemContext = {
  readonly physics: PhysicsWorld | undefined;
  readonly rewardChoice: RewardChoiceHandle | undefined;
  readonly requestDefeat: () => void;
  readonly onHit: (attacker: EntityHandle, remainingHealth: number, shielded: boolean) => void;
};

/** Assemble the one counterattack owner around ECS health, hazard state, and real physics contacts. */
export function createCounterattack(
  world: World,
  player: EntityHandle,
  collectedEnergyCores: () => number,
): CounterattackHandle {
  const activeHazards = world.query({ with: [BouncyBallHazard, Transform] }).unwrap();
  const disabledHazards = world.query({ with: [BouncyBallHazard, Disabled, Transform] }).unwrap();
  const damageHazards = world.query({ with: [DamageHazard] }).unwrap();
  const activeEntities = (): EntityHandle[] => [...activeHazards].map((row) => row.entity);
  const disabledEntities = (): EntityHandle[] => [...disabledHazards].map((row) => row.entity);
  let lastShieldedHealth: number | null = null;

  const reset = (): void => {
    lastShieldedHealth = null;
    world.set(player, PlayerHealth, { current: PLAYER_MAX_HEALTH, max: PLAYER_MAX_HEALTH });
    const disabled = disabledEntities();
    const hazards = [...activeEntities(), ...disabled];
    for (const entity of disabled) world.removeComponent(entity, Disabled).unwrap();
    for (const entity of hazards) {
      world.set(entity, BouncyBallHazard, { mode: 0, patrolAngle: 0 });
    }
    for (const row of damageHazards) {
      world.set(row.entity, DamageHazard, { cooldown: 0, acceptedHits: 0 });
    }
  };
  const damage = (entity: EntityHandle | undefined) => entity === undefined
    ? undefined
    : world.get(entity, DamageHazard);
  const damageEntities = (): EntityHandle[] => [...damageHazards].map((row) => row.entity);
  const setDamageCooldown = (entity: EntityHandle, cooldown: number): void => {
    const source = world.get(entity, DamageHazard);
    if (source.ok) world.set(entity, DamageHazard, { cooldown });
  };
  const decrementDamageCooldowns = (dt: number, shieldReady: boolean): void => {
    for (const entity of damageEntities()) {
      const source = world.get(entity, DamageHazard);
      if (source.ok && shieldReady && world.get(entity, BouncyBallHazard).ok) {
        world.set(entity, DamageHazard, { cooldown: COUNTERATTACK_COOLDOWN_SECONDS });
        continue;
      }
      if (source.ok && source.value.cooldown > 0) {
        world.set(entity, DamageHazard, { cooldown: Math.max(0, source.value.cooldown - dt) });
      }
    }
  };
  const arm = (): boolean => {
    const disabled = disabledEntities()[0];
    const entity = disabled ?? activeEntities()[0];
    if (entity === undefined) return false;
    if (disabled !== undefined) world.removeComponent(disabled, Disabled).unwrap();
    setDamageCooldown(entity, COUNTERATTACK_COOLDOWN_SECONDS);
    return true;
  };
  let consequenceContext: CounterattackSystemContext | undefined;
  const admitDamage = (roles: { readonly hazardEntity: EntityHandle; readonly feedbackEntity: EntityHandle }): CounterattackContactResult => {
    const hazard = world.get(roles.hazardEntity, DamageHazard);
    const health = world.get(player, PlayerHealth);
    if (!hazard.ok || !health.ok || consequenceContext === undefined) {
      return resolveCounterattackContact({ health: health.ok ? health.value.current : 0, cooldown: 1 });
    }
    const result = resolveCounterattackContact({
      health: health.value.current,
      cooldown: hazard.value.cooldown,
      shieldReady: consequenceContext.rewardChoice?.snapshot().state === 'shield-ready',
    });
    if (!result.admitted) return result;
    if (result.shieldConsumed) {
      consequenceContext.rewardChoice?.consumeShield();
      lastShieldedHealth = result.health;
    }
    world.set(player, PlayerHealth, { current: result.health });
    world.set(roles.hazardEntity, DamageHazard, {
      cooldown: result.cooldown,
      acceptedHits: hazard.value.acceptedHits + 1,
    });
    consequenceContext.onHit(roles.feedbackEntity, result.health, result.shieldConsumed);
    if (result.defeated) consequenceContext.requestDefeat();
    return result;
  };

  const snapshot = (): CounterattackSnapshot => {
    const pressure = deriveCounterattackPressure(collectedEnergyCores());
    const health = world.get(player, PlayerHealth);
    const playerTransform = world.get(player, Transform);
    const active = activeEntities()[0];
    const disabled = disabledEntities()[0];
    const hazardEntity = active ?? disabled;
    const hazard = hazardEntity === undefined ? undefined : world.get(hazardEntity, BouncyBallHazard);
    const hazardDamage = damage(hazardEntity);
    const hazardTransform = hazardEntity === undefined ? undefined : world.get(hazardEntity, Transform);
    const hazardMode = hazardEntity === undefined
      ? 'unavailable'
      : disabled !== undefined
        ? 'disabled'
        : hazard?.ok === true && hazard.value.mode === 1
          ? 'chase'
          : 'patrol';
    return {
      playerHealth: health.ok ? health.value.current : 0,
      playerMaxHealth: health.ok ? health.value.max : PLAYER_MAX_HEALTH,
      playerPosition: playerTransform.ok
        ? [playerTransform.value.pos[0] ?? 0, playerTransform.value.pos[1] ?? 0, playerTransform.value.pos[2] ?? 0]
        : [0, 0, 0],
      hazardEntity: hazardEntity ?? null,
      hazardActive: active !== undefined,
      hazardMode,
      hazardPosition: hazardTransform?.ok === true
        ? [hazardTransform.value.pos[0] ?? 0, hazardTransform.value.pos[1] ?? 0, hazardTransform.value.pos[2] ?? 0]
        : null,
      pressureTier: pressure.tier,
      patrolSpeed: pressure.patrolSpeed,
      chaseSpeed: pressure.chaseSpeed,
      pursuitRadius: pressure.pursuitRadius,
      cooldown: hazardDamage?.ok === true ? hazardDamage.value.cooldown : 0,
      acceptedHits: hazardDamage?.ok === true ? hazardDamage.value.acceptedHits : 0,
      lastShieldedHealth,
    };
  };

  const installSystem = (ctx: CounterattackSystemContext): void => {
    consequenceContext = ctx;
    world.addSystem(FixedUpdate, {
      name: 'game-counterattack',
      runIf: inState(GameState, 'Play'),
      after: ['physicsCollisionSync', 'game-player-movement'],
      queries: [],
      fn: () => {
        // Counterattack pressure is proven against FixedTime. A long host
        // frame must not turn one variable-rate Update into a movement jump
        // larger than one simulation step.
        const dt = world.getResource(FixedTime).delta;
        decrementDamageCooldowns(dt, ctx.rewardChoice?.snapshot().state === 'shield-ready');
        const playerTransform = world.get(player, Transform);
        if (!playerTransform.ok) return;
        const playerX = playerTransform.value.pos[0] ?? 0;
        const playerZ = playerTransform.value.pos[2] ?? 0;
        const pressure = deriveCounterattackPressure(collectedEnergyCores());

        for (const attacker of activeEntities()) {
          const hazard = world.get(attacker, BouncyBallHazard);
          const transform = world.get(attacker, Transform);
          const resetPose = world.get(attacker, ResetPose);
          if (!hazard.ok || !transform.ok || !resetPose.ok) continue;
          const x = transform.value.pos[0] ?? 0;
          const y = transform.value.pos[1] ?? 0;
          const z = transform.value.pos[2] ?? 0;
          const playerDx = playerX - x;
          const playerDz = playerZ - z;
          const playerDistance = Math.hypot(playerDx, playerDz);
          const chase = playerDistance <= pressure.pursuitRadius;
          const patrolAngle = (hazard.value.patrolAngle + dt * 0.55) % (Math.PI * 2);
          const targetX = chase ? playerX : resetPose.value.posX + Math.cos(patrolAngle) * 2.2;
          const targetZ = chase ? playerZ : resetPose.value.posZ + Math.sin(patrolAngle) * 2.2;
          const dx = targetX - x;
          const dz = targetZ - z;
          const distance = Math.hypot(dx, dz);
          const speed = chase ? pressure.chaseSpeed : pressure.patrolSpeed;
          const step = Math.min(distance, speed * dt);
          if (distance > 0.001) {
            world.set(attacker, Transform, { pos: [x + dx / distance * step, y, z + dz / distance * step] });
          }
          world.set(attacker, BouncyBallHazard, {
            mode: chase ? 1 : 0,
            patrolAngle,
          });
        }

        const collisions = world.get(player, CollidingEntities);
        if (!collisions.ok) return;
        for (const entity of collisions.value.entities) {
          const attacker = entity as EntityHandle;
          if (ctx.physics?.hasBody(attacker) !== true) continue;
          if (world.get(attacker, Disabled).ok) continue;
          admitDamage({ hazardEntity: attacker, feedbackEntity: attacker });
        }
      },
    }).unwrap();
  };

  reset();
  return { arm, admitDamage, reset, snapshot, installSystem };
}
