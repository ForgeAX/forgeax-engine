import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Time, Update, World, defineComponent, type EntityHandle } from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

export const CHANGE_DETECTION_RESOURCE = 'bevyChangeDetectionResource';
const STEP_SECONDS = 0.25;
const ChangeMarker = defineComponent('ChangeDetectionChangeMarker', { value: 'f32' });
const AddedMarker = defineComponent('ChangeDetectionAddedMarker', { value: 'f32' });

export interface ChangeDetectionState {
  elapsed: number;
  changedHits: number;
  addedHits: number;
  resourceChanged: number;
  changeEntity: EntityHandle;
  addedEntity: EntityHandle;
}

export interface ChangeDetectionSnapshot extends ChangeDetectionState {
  changeValue: number;
  addedValue: number;
  resourceValue: number;
  changeTick: number;
}

function spawnMarker(world: World, component: typeof ChangeMarker | typeof AddedMarker, pos: readonly [number, number, number], color: readonly [number, number, number, number]): EntityHandle {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit(color));
  return world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [80, 80, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component, data: { value: 0 } },
  ).unwrap();
}

export function buildChangeDetectionWorld(world: World): ChangeDetectionState {
  const changeEntity = spawnMarker(world, ChangeMarker, [-180, 90, 0], [1, 0.25, 0.15, 1]);
  const addedEntity = spawnMarker(world, AddedMarker, [180, -90, 0], [0.15, 0.8, 1, 1]);
  world.spawn({ component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } }, { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) });

  const state: ChangeDetectionState = { elapsed: 0, changedHits: 0, addedHits: 0, resourceChanged: 0, changeEntity, addedEntity };
  let lastResourceChangeTick = -1;
  world.insertResource(CHANGE_DETECTION_RESOURCE, { value: 0 });

  world.addSystem(Update, {
    name: 'change-detection-writer', queries: [],
    fn: (world) => {
      state.elapsed += world.getResource(Time).delta;
      const value = Math.floor(state.elapsed / STEP_SECONDS);
      const current = world.get(changeEntity, ChangeMarker).unwrap().value;
      if (value !== current) world.set(changeEntity, ChangeMarker, { value }).unwrap();
      const resource = world.getResource<{ value: number }>(CHANGE_DETECTION_RESOURCE);
      if (resource.value !== value) world.insertResource(CHANGE_DETECTION_RESOURCE, { value });
    },
  }).unwrap();

  world.addSystem(Update, {
    name: 'change-detection-changed-query',
    queries: [{ changed: [ChangeMarker] }],
    fn: (_world, queryResults) => {
      for (const _row of queryResults[0]) state.changedHits += 1;
    },
  }).unwrap();

  world.addSystem(Update, {
    name: 'change-detection-added-query',
    queries: [{ added: [AddedMarker] }],
    fn: (_world, queryResults) => {
      for (const _row of queryResults[0]) state.addedHits += 1;
    },
  }).unwrap();

  world.addSystem(Update, {
    name: 'change-detection-resource-probe', queries: [],
    fn: (world) => {
      const ticks = world.getResourceChange(CHANGE_DETECTION_RESOURCE);
      if (ticks !== undefined && ticks.changed > lastResourceChangeTick) {
        state.resourceChanged += 1;
        lastResourceChangeTick = ticks.changed;
      }
    },
  }).unwrap();
  return state;
}

export function readChangeDetectionState(world: World, state: ChangeDetectionState): ChangeDetectionSnapshot {
  return {
    ...state,
    changeValue: world.get(state.changeEntity, ChangeMarker).unwrap().value,
    addedValue: world.get(state.addedEntity, AddedMarker).unwrap().value,
    resourceValue: world.getResource<{ value: number }>(CHANGE_DETECTION_RESOURCE).value,
    changeTick: world.getResourceChange(CHANGE_DETECTION_RESOURCE)?.changed ?? -1,
  };
}
