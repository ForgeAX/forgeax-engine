// Reproduction of Bevy's ecs/system_param example.
//
// A reusable parameter owns its query and resource contract. The system only
// receives the resolved PlayerCounter value, keeping access explicit without
// rebuilding the same query/resource plumbing at every call site.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import {
  Time,
  Update,
  World,
  defineComponent,
  type EntityHandle,
} from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

export const SYSTEM_PARAM_COUNT = 'bevySystemParamPlayerCount';

const TRACK_WIDTH = 520;
const PLAYER_START = -TRACK_WIDTH / 2;
const COUNTER_START = TRACK_WIDTH / 2;

export const SystemParamPlayer = defineComponent('SystemParamPlayer', {});
export const SystemParamCounter = defineComponent('SystemParamCounter', {});

export interface PlayerCountResource {
  value: number;
}

export interface SystemParamState {
  elapsed: number;
  runs: number;
  playerCount: number;
  counterX: number;
  counterEntity: EntityHandle;
}

export interface SystemParamSnapshot {
  elapsed: number;
  runs: number;
  playerCount: number;
  resourceValue: number;
  counterX: number;
}

function spawnMarker(
  world: World,
  marker: typeof SystemParamPlayer | typeof SystemParamCounter,
  pos: readonly [number, number, number],
  scale: number,
  color: readonly [number, number, number, number],
): EntityHandle {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit(color));
  return world
    .spawn(
      { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [scale, scale, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: marker, data: {} },
    )
    .unwrap();
}

function setX(world: World, entity: EntityHandle, x: number): void {
  const current = world.get(entity, Transform).unwrap();
  world.set(entity, Transform, {
    pos: [x, current.pos[1] ?? 0, current.pos[2] ?? 0],
  }).unwrap();
}

function counterX(playerCount: number, elapsed: number): number {
  return COUNTER_START + Math.sin(elapsed * 1.4) * (24 + playerCount * 12);
}

export function buildSystemParamWorld(world: World): SystemParamState {
  const playerPositions: readonly [number, number, number][] = [
    [PLAYER_START, 120, 0],
    [PLAYER_START + 130, 120, 0],
    [PLAYER_START + 260, 120, 0],
  ];
  for (const pos of playerPositions) {
    spawnMarker(world, SystemParamPlayer, pos, 56, [0.2, 0.7, 1, 1]);
  }
  const counterEntity = spawnMarker(
    world,
    SystemParamCounter,
    [COUNTER_START, -120, 0],
    82,
    [1, 0.35, 0.15, 1],
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );

  const state: SystemParamState = {
    elapsed: 0,
    runs: 0,
    playerCount: 0,
    counterX: COUNTER_START,
    counterEntity,
  };
  world.insertResource(SYSTEM_PARAM_COUNT, { value: 0 } satisfies PlayerCountResource);

  world.addSystem(Update, {
    name: 'system-param-counter',
    queries: [{ with: [SystemParamPlayer] }],
    fn: (world, queryResults) => {
      let playerCount = 0;
      for (const _row of queryResults[0]) playerCount += 1;
      const counter = {
        playerCount,
        resource: world.getResource<PlayerCountResource>(SYSTEM_PARAM_COUNT),
      };
      state.elapsed += world.getResource<typeof Time>(Time).delta;
      state.runs += 1;
      counter.resource.value = counter.playerCount;
      state.playerCount = counter.playerCount;
      state.counterX = counterX(counter.playerCount, state.elapsed);
      setX(world, counterEntity, state.counterX);
    },
  }).unwrap();

  return state;
}

export function readSystemParamState(world: World, state: SystemParamState): SystemParamSnapshot {
  const counter = world.get(state.counterEntity, Transform);
  return {
    elapsed: state.elapsed,
    runs: state.runs,
    playerCount: state.playerCount,
    resourceValue: world.getResource<PlayerCountResource>(SYSTEM_PARAM_COUNT).value,
    counterX: counter.ok ? (counter.value.pos[0] ?? Number.NaN) : Number.NaN,
  };
}
