// Reproduction of Bevy's ecs/entity_disabling example.
//
// Disabled is an ECS marker: ordinary queries exclude it, while a query that
// explicitly includes Disabled can inspect and re-enable those entities.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import {
  Disabled,
  Time,
  Update,
  World,
  defineComponent,
  type Query,
  type EntityHandle,
} from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

export const DisableOnClick = defineComponent('EntityDisablingTarget', { slot: 'u32' });

const TARGET_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [-260, 0, 0],
  [0, 0, 0],
  [260, 0, 0],
];
const TARGET_COLORS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.95, 0.2, 0.25, 1],
  [0.2, 0.8, 1, 1],
  [0.25, 0.95, 0.35, 1],
];

export interface EntityDisablingState {
  elapsed: number;
  disabledAt: number | null;
  reenabledAt: number | null;
  activeCount: number;
  disabledCount: number;
}

export interface EntityDisablingSnapshot extends EntityDisablingState {
  transition: string;
}

function spawnTarget(
  world: World,
  slot: number,
  pos: readonly [number, number, number],
  color: readonly [number, number, number, number],
): EntityHandle {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit(color));
  return world
    .spawn(
      { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [100, 100, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: DisableOnClick, data: { slot } },
    )
    .unwrap();
}

function countEntities(query: Query): number {
  let count = 0;
  for (const _row of query) count += 1;
  return count;
}

export function buildEntityDisablingWorld(world: World): EntityDisablingState {
  TARGET_POSITIONS.forEach((pos, slot) => spawnTarget(world, slot, pos, TARGET_COLORS[slot]!));
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    {
      component: Camera,
      data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }),
    },
  );

  const activeQuery = world.query({ with: [DisableOnClick] }).unwrap();
  const disabledQuery = world.query({ with: [DisableOnClick, Disabled] }).unwrap();
  const state: EntityDisablingState = {
    elapsed: 0,
    disabledAt: null,
    reenabledAt: null,
    activeCount: TARGET_POSITIONS.length,
    disabledCount: 0,
  };

  world
    .addSystem(Update, {
      name: 'entity-disabling-timeline',
      queries: [
        { with: [DisableOnClick] },
        { with: [DisableOnClick, Disabled] },
      ],
      fn: (world, queryResults, commands) => {
        state.elapsed += world.getResource<typeof Time>(Time).delta;
        if (state.disabledAt === null && state.elapsed >= 0.5) {
          let first: EntityHandle | undefined;
          for (const row of queryResults[0]) {
            first = row.entity;
            break;
          }
          if (first !== undefined) {
            commands.addComponent(first, { component: Disabled, data: {} });
            state.disabledAt = state.elapsed;
          }
        } else if (state.reenabledAt === null && state.elapsed >= 1.2) {
          for (const row of queryResults[1]) commands.removeComponent(row.entity, Disabled);
          state.reenabledAt = state.elapsed;
        }
      },
    })
    .unwrap();

  state.activeCount = countEntities(activeQuery);
  state.disabledCount = countEntities(disabledQuery);
  return state;
}

export function readEntityDisablingState(
  world: World,
  state: EntityDisablingState,
): EntityDisablingSnapshot {
  const activeQuery = world.query({ with: [DisableOnClick] }).unwrap();
  const disabledQuery = world.query({ with: [DisableOnClick, Disabled] }).unwrap();
  state.activeCount = countEntities(activeQuery);
  state.disabledCount = countEntities(disabledQuery);
  return {
    ...state,
    transition:
      state.reenabledAt !== null ? 'reenabled' : state.disabledAt !== null ? 'disabled' : 'active',
  };
}
