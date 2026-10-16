import { Disabled, FixedUpdate, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { inState } from '@forgeax/engine-state';
import { quat, type Handle } from '@forgeax/engine-runtime';
import {
  Projectile,
  Sentinel,
  TargetPresentation,
  projectileAllegianceFromValue,
} from './components/gameplay';
import type { EnergyCoreExtractionHandle } from './energy-core-extraction';
import { GameState } from './gameplay-state';
import type { ProjectileImpactOutcome } from './projectile-impact';
import type { ProjectilePresentation } from './projectile-presentation';
import type { SentinelEncounterReadiness } from './sentinel-authorship';
import { GAME_DEFAULT_GAMEPLAY_CONFIG, type GameplayConfig } from './resources/gameplay';
import { spawnSharedProjectile } from './systems/projectile-simulation';
import type { GameplayVfx } from './gameplay-vfx';

export const SENTINEL_TELEGRAPH_TICKS = 45;
export const SENTINEL_COOLDOWN_TICKS = 90;
export const SENTINEL_PROJECTILE_SPEED = 10;
export const SENTINEL_PROJECTILE_LIFE = 2.5;

export type SentinelMode = 'dormant' | 'telegraph' | 'cooldown';
export type SentinelCadence = {
  readonly mode: SentinelMode;
  readonly ticks: number;
  readonly aim: readonly [number, number, number];
  readonly shotsFired: number;
};

export function initialSentinelCadence(): SentinelCadence {
  return { mode: 'dormant', ticks: 0, aim: [0, 0, 0], shotsFired: 0 };
}

export function advanceSentinelCadence(
  state: SentinelCadence,
  input: {
    readonly collected: number;
    readonly playerChest: readonly [number, number, number];
    readonly disabled?: boolean;
    readonly playing?: boolean;
    readonly telegraphTicks?: number;
    readonly cooldownTicks?: number;
  },
): SentinelCadence {
  if (input.disabled === true || input.playing === false) return initialSentinelCadence();
  if (state.mode === 'dormant') {
    return input.collected < 1
      ? state
      : {
          ...state,
          mode: 'telegraph',
          ticks: input.telegraphTicks ?? SENTINEL_TELEGRAPH_TICKS,
          aim: [...input.playerChest],
        };
  }
  if (state.ticks > 1) return { ...state, ticks: state.ticks - 1 };
  if (state.mode === 'telegraph') {
    return {
      ...state,
      mode: 'cooldown',
      ticks: input.cooldownTicks ?? SENTINEL_COOLDOWN_TICKS,
      shotsFired: state.shotsFired + 1,
    };
  }
  return {
    ...state,
    mode: 'telegraph',
    ticks: input.telegraphTicks ?? SENTINEL_TELEGRAPH_TICKS,
    aim: [...input.playerChest],
  };
}

function modeValue(mode: SentinelMode): number {
  return mode === 'telegraph' ? 1 : mode === 'cooldown' ? 2 : 0;
}

function modeFromValue(value: number): SentinelMode {
  return value === 1 ? 'telegraph' : value === 2 ? 'cooldown' : 'dormant';
}

export type SentinelSnapshot = {
  readonly entity: number;
  readonly authoredLocalId: 35;
  readonly mode: SentinelMode;
  readonly ticks: number;
  readonly frozenAim: readonly [number, number, number] | null;
  readonly physicsReady: boolean;
  readonly shotsFired: number;
  readonly coverBlocked: number;
  readonly playerHits: number;
  readonly shieldBlocks: number;
  readonly refused: number;
};

export type SentinelRangedThreat = {
  readonly entity: EntityHandle;
  readonly installSystem: () => void;
  readonly reset: () => void;
  readonly cleanupHostileProjectiles: () => void;
  readonly recordOutcome: (source: EntityHandle, outcome: ProjectileImpactOutcome, shielded: boolean) => void;
  readonly onTargetResolved: (target: EntityHandle) => void;
  readonly snapshot: () => SentinelSnapshot;
};

export function createSentinelRangedThreat(args: {
  readonly world: World;
  readonly entity: EntityHandle;
  readonly player: EntityHandle;
  readonly extraction: EnergyCoreExtractionHandle | undefined;
  readonly readiness: () => SentinelEncounterReadiness;
  readonly presentation: ProjectilePresentation;
  readonly projectileEntities: () => readonly EntityHandle[];
  readonly consumeProjectile: (entity: EntityHandle) => void;
  readonly onSpawn: () => void;
  readonly vfx?: GameplayVfx;
}): SentinelRangedThreat {
  const originalPresentation = args.world.get(args.entity, TargetPresentation);
  const originalMaterials = originalPresentation.ok
    ? [...originalPresentation.value.authoredMaterials] as Handle<'MaterialAsset', 'shared'>[]
    : [];
  const readCadence = (): SentinelCadence => {
    const current = args.world.get(args.entity, Sentinel);
    return current.ok
      ? {
          mode: modeFromValue(current.value.mode),
          ticks: current.value.ticks,
          aim: [current.value.aimX, current.value.aimY, current.value.aimZ],
          shotsFired: current.value.shotsFired,
        }
      : initialSentinelCadence();
  };
  const writeCadence = (state: SentinelCadence): void => {
    args.world.set(args.entity, Sentinel, {
      mode: modeValue(state.mode),
      ticks: state.ticks,
      aimX: state.aim[0],
      aimY: state.aim[1],
      aimZ: state.aim[2],
      shotsFired: state.shotsFired,
    });
    if (state.mode === 'telegraph') {
      args.world.set(args.entity, MeshRenderer, { materials: [args.presentation.hostileProjectileMaterial] });
    } else if (originalMaterials.length > 0) {
      args.world.set(args.entity, MeshRenderer, { materials: originalMaterials });
    }
  };
  const cleanupHostileProjectiles = (): void => {
    for (const entity of args.projectileEntities()) {
      const projectile = args.world.get(entity, Projectile);
      if (!projectile.ok) continue;
      if (projectile.value.source !== args.entity) continue;
      if (projectileAllegianceFromValue(projectile.value.allegiance) !== 'hostile') continue;
      args.consumeProjectile(entity);
    }
    args.vfx?.stopHostile();
  };
  const reset = (): void => {
    cleanupHostileProjectiles();
    args.world.set(args.entity, Sentinel, {
      mode: 0,
      ticks: 0,
      aimX: 0,
      aimY: 0,
      aimZ: 0,
      shotsFired: 0,
      coverBlocked: 0,
      playerHits: 0,
      shieldBlocks: 0,
      refused: 0,
    });
    if (originalMaterials.length > 0) args.world.set(args.entity, MeshRenderer, { materials: originalMaterials });
  };
  const recordOutcome = (source: EntityHandle, outcome: ProjectileImpactOutcome, shielded: boolean): void => {
    if (source !== args.entity) return;
    const current = args.world.get(args.entity, Sentinel);
    if (!current.ok) return;
    if (outcome === 'cover-blocked') args.world.set(args.entity, Sentinel, { coverBlocked: current.value.coverBlocked + 1 });
    else if (outcome === 'player') {
      args.world.set(args.entity, Sentinel, shielded
        ? { shieldBlocks: current.value.shieldBlocks + 1 }
        : { playerHits: current.value.playerHits + 1 });
    } else if (outcome === 'refused') args.world.set(args.entity, Sentinel, { refused: current.value.refused + 1 });
  };
  const onTargetResolved = (target: EntityHandle): void => {
    if (target === args.entity && args.world.get(target, Disabled).ok) cleanupHostileProjectiles();
  };
  const installSystem = (): void => {
    args.world.addSystem(FixedUpdate, {
      name: 'game-sentinel-cadence',
      runIf: inState(GameState, 'Play'),
      queries: [],
      fn: (_world, _queries, commands) => {
        const disabled = args.world.get(args.entity, Disabled).ok;
        const playerTransform = args.world.get(args.player, Transform);
        const sentinelTransform = args.world.get(args.entity, Transform);
        if (!playerTransform.ok || !sentinelTransform.ok || !args.readiness().available) return;
        const playerChest: readonly [number, number, number] = [
          playerTransform.value.pos[0] ?? 0,
          (playerTransform.value.pos[1] ?? 0) + 0.55,
          playerTransform.value.pos[2] ?? 0,
        ];
        const previous = readCadence();
        const config = args.world.getResource<GameplayConfig>(GAME_DEFAULT_GAMEPLAY_CONFIG);
        const next = advanceSentinelCadence(previous, {
          collected: args.extraction?.snapshot().collected ?? 0,
          playerChest,
          disabled,
          telegraphTicks: config.sentinel.telegraphTicks,
          cooldownTicks: config.sentinel.cooldownTicks,
        });
        const sx = sentinelTransform.value.pos[0] ?? 0;
        const sy = (sentinelTransform.value.pos[1] ?? 0) + 0.45;
        const sz = sentinelTransform.value.pos[2] ?? 0;
        writeCadence(next);
        if (next.mode === 'telegraph' && previous.mode !== 'telegraph') {
          args.vfx?.beginTelegraph([sx, sy, sz]);
        }
        if (next.shotsFired === previous.shotsFired) return;
        const dx = next.aim[0] - sx;
        const dy = next.aim[1] - sy;
        const dz = next.aim[2] - sz;
        const length = Math.hypot(dx, dy, dz);
        if (length <= 0.001) return;
        const direction: readonly [number, number, number] = [dx / length, dy / length, dz / length];
        const rotation = quat.fromUnitVectors(quat.create(), [0, 1, 0], direction);
        const projectile = spawnSharedProjectile(commands, {
          source: args.entity,
          allegiance: 'hostile',
          position: [sx + direction[0] * 0.75, sy + direction[1] * 0.75, sz + direction[2] * 0.75],
          rotation: [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!],
          scale: 1.15,
          velocity: [
            direction[0] * config.sentinel.projectileSpeed,
            direction[1] * config.sentinel.projectileSpeed,
            direction[2] * config.sentinel.projectileSpeed,
          ],
          life: config.sentinel.projectileLife,
          impactScale: 1,
          radius: config.projectile.radius,
          halfHeight: config.projectile.halfHeight,
          mesh: args.presentation.projectileMesh,
          material: args.presentation.hostileProjectileMaterial,
          ...(args.vfx === undefined ? {} : { presentation: args.vfx.flightPresentation() }),
        });
        args.vfx?.attachFlight(projectile);
        args.onSpawn();
      },
    }).unwrap();
  };
  const snapshot = (): SentinelSnapshot => {
    const current = args.world.get(args.entity, Sentinel);
    const mode = current.ok ? modeFromValue(current.value.mode) : 'dormant';
    return {
      entity: args.entity,
      authoredLocalId: 35,
      mode,
      ticks: current.ok ? current.value.ticks : 0,
      frozenAim: current.ok && mode !== 'dormant'
        ? [current.value.aimX, current.value.aimY, current.value.aimZ]
        : null,
      physicsReady: args.readiness().sentinelBodyReady,
      shotsFired: current.ok ? current.value.shotsFired : 0,
      coverBlocked: current.ok ? current.value.coverBlocked : 0,
      playerHits: current.ok ? current.value.playerHits : 0,
      shieldBlocks: current.ok ? current.value.shieldBlocks : 0,
      refused: current.ok ? current.value.refused : 0,
    };
  };
  reset();
  return { entity: args.entity, installSystem, reset, cleanupHostileProjectiles, recordOutcome, onTargetResolved, snapshot };
}
