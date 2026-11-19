import { defineResource } from '@forgeax/engine-ecs';

import { defineSystem } from "@forgeax/engine-ecs";
import { Time, Update, World, defineComponent, type EntityHandle } from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';

import { Transform } from '@forgeax/engine-scene';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


export const CHANGE_DETECTION_RESOURCE = defineResource<{ value: number; revision: number }>("bevyChangeDetectionResource");
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
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveCube = sceneAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

  const material = sceneAssets.create(Materials.unlit(color)).unwrap();
  return world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [80, 80, 1] } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component, data: { value: 0 } },
  ).unwrap();
}

export function buildChangeDetectionWorld(world: World): ChangeDetectionState {
  const changeEntity = spawnMarker(world, ChangeMarker, [-180, 90, 0], [1, 0.25, 0.15, 1]);
  const addedEntity = spawnMarker(world, AddedMarker, [180, -90, 0], [0.15, 0.8, 1, 1]);
  world.spawn({ component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } }, { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) });

  const state: ChangeDetectionState = { elapsed: 0, changedHits: 0, addedHits: 0, resourceChanged: 0, changeEntity, addedEntity };
  let lastResourceRevision = -1;
  world.insertResource(CHANGE_DETECTION_RESOURCE, { value: 0, revision: 0 });

  const systemToken1 = defineSystem({
    name: 'change-detection-writer', queries: [],
    fn: (world) => {
      state.elapsed += world.getResource(Time).delta;
      const value = Math.floor(state.elapsed / STEP_SECONDS);
      const current = world.get(changeEntity, ChangeMarker).unwrap().value;
      if (value !== current) world.set(changeEntity, ChangeMarker, { value }).unwrap();
      const resource = world.getResource(CHANGE_DETECTION_RESOURCE);
      if (resource.value !== value)
        world.insertResource(CHANGE_DETECTION_RESOURCE, { value, revision: resource.revision + 1 });
    },
  });
world.addSystem(Update, systemToken1).unwrap();

  const systemToken2 = defineSystem({
    name: 'change-detection-changed-query',
    queries: [{ changed: [ChangeMarker] }],
    fn: (_world, queryResults) => {
      for (const _row of queryResults[0]) state.changedHits += 1;
    },
  });
world.addSystem(Update, systemToken2).unwrap();

  const systemToken3 = defineSystem({
    name: 'change-detection-added-query',
    queries: [{ added: [AddedMarker] }],
    fn: (_world, queryResults) => {
      for (const _row of queryResults[0]) state.addedHits += 1;
    },
  });
world.addSystem(Update, systemToken3).unwrap();

  const systemToken4 = defineSystem({
    name: 'change-detection-resource-probe', queries: [],
    fn: (world) => {
      const { revision } = world.getResource(CHANGE_DETECTION_RESOURCE);
      if (revision > lastResourceRevision) {
        state.resourceChanged += 1;
        lastResourceRevision = revision;
      }
    },
  });
world.addSystem(Update, systemToken4).unwrap();
  return state;
}

export function readChangeDetectionState(world: World, state: ChangeDetectionState): ChangeDetectionSnapshot {
  const resource = world.getResource(CHANGE_DETECTION_RESOURCE);
  return {
    ...state,
    changeValue: world.get(state.changeEntity, ChangeMarker).unwrap().value,
    addedValue: world.get(state.addedEntity, AddedMarker).unwrap().value,
    resourceValue: resource.value,
    changeTick: resource.revision,
  };
}
