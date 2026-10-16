import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { HealthPickupHandle } from './health-pickup';

export const RepairCache = defineComponent('GameDefaultRepairCache', {
  pickupLocalId: 'u32',
  opened: 'bool',
}, { transient: true });

export type RepairCacheImpact = {
  readonly authoredTarget: boolean;
  readonly impactScale: number;
  readonly opened: boolean;
};

export type RepairCacheImpactResult = 'open' | 'ordinary' | 'other-target' | 'already-open';

export function resolveRepairCacheImpact(impact: RepairCacheImpact): RepairCacheImpactResult {
  if (!impact.authoredTarget) return 'other-target';
  if (impact.opened) return 'already-open';
  if (impact.impactScale <= 1) return 'ordinary';
  return 'open';
}

export type AuthoredRepairCacheIdentity = {
  readonly target: EntityHandle;
  readonly targetLocalId: number;
  readonly pickupLocalId: number;
};

export type RepairCacheSnapshot = {
  readonly targetLocalId: number;
  readonly targetEntity: number;
  readonly pickupLocalId: number;
  readonly opened: boolean;
  readonly opens: number;
  readonly ordinaryHits: number;
  readonly alreadyOpenHits: number;
  readonly position: readonly [number, number, number];
};

export type RepairCacheHandle = {
  readonly recordImpact: (entity: EntityHandle, impactScale: number) => RepairCacheImpactResult;
  readonly reset: () => void;
  readonly snapshot: () => RepairCacheSnapshot;
};

/** Admit only an already-resolved hit and reveal the exact authored pickup once. */
export function createRepairCache(
  world: World,
  authored: AuthoredRepairCacheIdentity,
  healthPickups: HealthPickupHandle,
): RepairCacheHandle {
  world.addComponent(authored.target, {
    component: RepairCache,
    data: { pickupLocalId: authored.pickupLocalId, opened: false },
  }).unwrap();
  let opened = false;
  let opens = 0;
  let ordinaryHits = 0;
  let alreadyOpenHits = 0;

  return {
    recordImpact: (entity, impactScale) => {
      const result = resolveRepairCacheImpact({
        authoredTarget: entity === authored.target,
        impactScale,
        opened,
      });
      if (result === 'ordinary') ordinaryHits += 1;
      if (result === 'already-open') alreadyOpenHits += 1;
      if (result !== 'open' || !healthPickups.activate(authored.pickupLocalId)) return result;
      opened = true;
      opens += 1;
      world.set(authored.target, RepairCache, { opened: true });
      return result;
    },
    reset: () => {
      opened = false;
      opens = 0;
      ordinaryHits = 0;
      alreadyOpenHits = 0;
      world.set(authored.target, RepairCache, { opened: false });
    },
    snapshot: () => {
      const transform = world.get(authored.target, GlobalTransform);
      const local = world.get(authored.target, Transform);
      return {
        targetLocalId: authored.targetLocalId,
        targetEntity: authored.target,
        pickupLocalId: authored.pickupLocalId,
        opened,
        opens,
        ordinaryHits,
        alreadyOpenHits,
        position: transform.ok
          ? [
              transform.value.world[12] ?? (local.ok ? local.value.pos[0] ?? 0 : 0),
              transform.value.world[13] ?? (local.ok ? local.value.pos[1] ?? 0 : 0),
              transform.value.world[14] ?? (local.ok ? local.value.pos[2] ?? 0 : 0),
            ]
          : [0, 0, 0],
      };
    },
  };
}
