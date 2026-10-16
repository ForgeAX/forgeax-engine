import {
  Disabled,
  type Query,
  World,
  defineComponent,
  type EntityHandle,
} from '@forgeax/engine-ecs';
import { ScoringTarget, scoringTargetEntities, type ScoringTargetQuery } from './scoring-target';

export const TargetDisabling = defineComponent('GameDefaultTargetDisabling', {});
export const GAME_DEFAULT_TARGET_DISABLING_WITNESS = '__forgeaxGameDefaultTargetDisablingWitness';

export type TargetDisablingWitness = {
  readonly activeCount: number;
  readonly disabledCount: number;
  readonly disableEvents: number;
};

export type TargetDisablingHandle = {
  readonly disable: (entity: EntityHandle) => void;
  readonly reset: () => void;
  readonly snapshot: () => TargetDisablingWitness;
};

function count(query: Query): number {
  let total = 0;
  for (const _row of query) total += 1;
  return total;
}

export function installTargetDisabling(world: World, targetQuery: ScoringTargetQuery): TargetDisablingHandle {
  const activeQuery = world.query({ with: [TargetDisabling] }).unwrap();
  const disabledQuery = world.query({ with: [TargetDisabling, Disabled] }).unwrap();
  for (const entity of scoringTargetEntities(targetQuery)) world.addComponent(entity, { component: TargetDisabling, data: {} }).unwrap();
  world.insertResource(GAME_DEFAULT_TARGET_DISABLING_WITNESS, { disableEvents: 0 });
  const state = world.getResource<{ disableEvents: number }>(GAME_DEFAULT_TARGET_DISABLING_WITNESS);

  const disable = (entity: EntityHandle): void => {
    if (!world.get(entity, ScoringTarget).ok || world.get(entity, Disabled).ok) return;
    world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
    state.disableEvents += 1;
  };

  const reset = (): void => {
    // Reset owns the original target list; mutating an archetype while iterating
    // its explicit Disabled query can invalidate the current chunk before every
    // row is visited. The query remains the read-side witness, while this stable
    // identity list makes reset deterministic.
    for (const entity of scoringTargetEntities(targetQuery)) {
      if (world.get(entity, Disabled).ok) {
        world.removeComponent(entity, Disabled).unwrap();
      }
    }
  };

  return {
    disable,
    reset,
    snapshot: () => ({
      activeCount: count(activeQuery),
      disabledCount: count(disabledQuery),
      disableEvents: state.disableEvents,
    }),
  };
}
