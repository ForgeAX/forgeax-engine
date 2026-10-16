import { FixedUpdate, type ComponentData, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { ParticleEffectPlayer } from '@forgeax/engine-vfx';
import { inState } from '@forgeax/engine-state';
import { AttackPresentation, ChargeShot, Projectile, PROJECTILE_ALLEGIANCE_PLAYER } from '../components/gameplay';
import type { GameplayVfx } from '../gameplay-vfx';
import { GameState } from '../gameplay-state';

export const ATTACK_CHARGE_SECONDS = 0.9;

export type AttackPresentationFrame = {
  readonly charging: boolean;
  readonly progress: number;
  readonly power: number;
  readonly began: boolean;
  readonly ended: boolean;
};

/** Derive one finite presentation frame from ECS-owned charge state. */
export function deriveAttackPresentationFrame(input: {
  readonly wasCharging: boolean;
  readonly active: boolean;
  readonly elapsed: number;
  readonly power: number;
}): AttackPresentationFrame {
  const charging = input.active;
  return {
    charging,
    progress: Math.min(1, Math.max(0, input.elapsed / ATTACK_CHARGE_SECONDS)),
    power: Math.max(1, input.power),
    began: charging && !input.wasCharging,
    ended: !charging && input.wasCharging,
  };
}

export function attackPresentationVariant(overcharged: boolean): number {
  return overcharged ? 1 : 0;
}

export type AttackPresentationSnapshot = {
  readonly available: boolean;
  readonly charging: boolean;
  readonly chargeProgress: number;
  readonly chargePower: number;
  readonly shotsFired: number;
  readonly trailStarts: number;
  readonly impactBursts: number;
  readonly misses: number;
  readonly overchargeShots: number;
  readonly overchargeImpacts: number;
  readonly activeTrails: number;
  readonly lastImpactScale: number;
  readonly lastVariant: 'normal' | 'overcharge';
};

const EMPTY_SNAPSHOT: AttackPresentationSnapshot = {
  available: false,
  charging: false,
  chargeProgress: 0,
  chargePower: 1,
  shotsFired: 0,
  trailStarts: 0,
  impactBursts: 0,
  misses: 0,
  overchargeShots: 0,
  overchargeImpacts: 0,
  activeTrails: 0,
  lastImpactScale: 1,
  lastVariant: 'normal',
};

export type AttackPresentationHandle = {
  readonly installSystem: () => void;
  readonly projectilePresentation: () => readonly ComponentData[];
  readonly onSpawn: (overcharged: boolean) => void;
  readonly onImpact: (position: readonly [number, number, number], overcharged: boolean, impactScale: number) => void;
  readonly onExpired: (entity: EntityHandle) => void;
  readonly stopProjectile: (entity: EntityHandle) => void;
  readonly stop: () => void;
  readonly reset: () => void;
  readonly snapshot: () => AttackPresentationSnapshot;
};

export function createAttackPresentation(options: {
  readonly world: World;
  readonly root: EntityHandle;
  readonly vfx: GameplayVfx;
  readonly projectileEntities: () => readonly EntityHandle[];
}): AttackPresentationHandle {
  let installed = false;

  const read = () => options.world.get(options.root, AttackPresentation);
  const setDefaults = (): void => {
    options.world.set(options.root, AttackPresentation, {
      charging: 0,
      chargeProgress: 0,
      chargePower: 1,
      shotsFired: 0,
      trailStarts: 0,
      impactBursts: 0,
      misses: 0,
      overchargeShots: 0,
      overchargeImpacts: 0,
      lastImpactScale: 1,
      lastVariant: 0,
    });
  };
  const isPlayerProjectile = (entity: EntityHandle): boolean => {
    const projectile = options.world.get(entity, Projectile);
    return projectile.ok && projectile.value.source === options.root && projectile.value.allegiance === PROJECTILE_ALLEGIANCE_PLAYER;
  };

  const handle: AttackPresentationHandle = {
    installSystem: () => {
      if (installed) return;
      installed = true;
      options.world.addSystem(FixedUpdate, {
        name: 'game-attack-presentation',
        runIf: inState(GameState, 'Play'),
        after: ['game-projectile-simulation'],
        queries: [],
        fn: () => {
          const charge = options.world.get(options.root, ChargeShot);
          const presentation = read();
          if (!charge.ok || !presentation.ok) return;
          const frame = deriveAttackPresentationFrame({
            wasCharging: presentation.value.charging !== 0,
            active: charge.value.active !== 0,
            elapsed: charge.value.elapsed,
            power: charge.value.power,
          });
          if (frame.began) options.vfx.beginCharge();
          if (frame.ended) options.vfx.endCharge();
          options.world.set(options.root, AttackPresentation, {
            charging: frame.charging ? 1 : 0,
            chargeProgress: frame.progress,
            chargePower: frame.power,
          });
        },
      }).unwrap();
    },
    projectilePresentation: () => options.vfx.attackFlightPresentation(),
    onSpawn: (overcharged) => {
      const presentation = read();
      if (!presentation.ok) return;
      const variant = attackPresentationVariant(overcharged);
      options.world.set(options.root, AttackPresentation, {
        shotsFired: presentation.value.shotsFired + 1,
        trailStarts: presentation.value.trailStarts + 1,
        overchargeShots: presentation.value.overchargeShots + (overcharged ? 1 : 0),
        lastVariant: variant,
      });
    },
    onImpact: (position, overcharged, impactScale) => {
      const presentation = read();
      if (!presentation.ok) return;
      options.world.set(options.root, AttackPresentation, {
        impactBursts: presentation.value.impactBursts + 1,
        overchargeImpacts: presentation.value.overchargeImpacts + (overcharged ? 1 : 0),
        lastImpactScale: impactScale,
        lastVariant: attackPresentationVariant(overcharged),
      });
      options.vfx.emitAttackImpact(position, overcharged);
    },
    onExpired: (entity) => {
      if (!isPlayerProjectile(entity)) return;
      const presentation = read();
      if (presentation.ok) options.world.set(options.root, AttackPresentation, { misses: presentation.value.misses + 1 });
    },
    stopProjectile: (entity) => {
      if (isPlayerProjectile(entity)) options.vfx.stopAttackFlight(entity);
    },
    stop: () => {
      for (const entity of options.projectileEntities()) handle.stopProjectile(entity);
      options.vfx.stopAttackEffects();
      const presentation = read();
      if (presentation.ok) options.world.set(options.root, AttackPresentation, { charging: 0, chargeProgress: 0 });
    },
    reset: () => {
      handle.stop();
      setDefaults();
      options.vfx.resetAttack();
    },
    snapshot: () => {
      const presentation = read();
      if (!presentation.ok) return EMPTY_SNAPSHOT;
      let activeTrails = 0;
      for (const entity of options.projectileEntities()) {
        if (!isPlayerProjectile(entity)) continue;
        const player = options.world.get(entity, ParticleEffectPlayer);
        if (player.ok && player.value.playing) activeTrails += 1;
      }
      return {
        available: true,
        charging: presentation.value.charging !== 0,
        chargeProgress: presentation.value.chargeProgress,
        chargePower: presentation.value.chargePower,
        shotsFired: presentation.value.shotsFired,
        trailStarts: presentation.value.trailStarts,
        impactBursts: presentation.value.impactBursts,
        misses: presentation.value.misses,
        overchargeShots: presentation.value.overchargeShots,
        overchargeImpacts: presentation.value.overchargeImpacts,
        activeTrails,
        lastImpactScale: presentation.value.lastImpactScale,
        lastVariant: presentation.value.lastVariant === 1 ? 'overcharge' : 'normal',
      };
    },
  };
  return handle;
}
