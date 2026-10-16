import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Time, Update, World, defineComponent, type EntityHandle } from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

const HOOK_STEP = 0.5;
interface HookBook {
  readonly index: Map<number, EntityHandle>;
  add: number;
  insert: number;
  discard: number;
  remove: number;
}

const hookBook: HookBook = { index: new Map(), add: 0, insert: 0, discard: 0, remove: 0 };

// Component lifecycle callbacks were intentionally removed from the ECS core.
// Keep this Bevy reproduction honest by recording the same facts at the
// explicit mutation sites below; the World mutation result remains the owner
// of success/failure and no hidden callback channel is introduced.
export const HookedMarker = defineComponent('ComponentHooksMarker', {
  key: 'u32',
  value: 'f32',
});

function recordMarkerInsert(entity: EntityHandle, key: number): void {
  hookBook.insert += 1;
  hookBook.index.set(key, entity);
}

function recordMarkerDiscard(key: number): void {
  hookBook.discard += 1;
  hookBook.index.delete(key);
}

interface ComponentHooksState {
  elapsed: number;
  addEntity: EntityHandle;
  rekeyEntity: EntityHandle;
  added: boolean;
  rekeyed: boolean;
  removed: boolean;
}

export interface ComponentHooksSnapshot {
  elapsed: number;
  add: number;
  insert: number;
  discard: number;
  remove: number;
  indexSize: number;
  rekey: number;
  remaining: number;
}

function spawnMarker(
  world: World,
  pos: readonly [number, number, number],
  color: readonly [number, number, number, number],
  component?: { component: typeof HookedMarker; data: { key: number; value: number } },
): EntityHandle {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit(color));
  const transform = { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [80, 80, 1] } };
  const meshFilter = { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } };
  const meshRenderer = { component: MeshRenderer, data: { materials: [material] } };
  if (component) {
    return world.spawn(transform, meshFilter, meshRenderer, component).unwrap();
  }
  return world.spawn(transform, meshFilter, meshRenderer).unwrap();
}

export function buildComponentHooksWorld(world: World): ComponentHooksState {
  hookBook.index.clear();
  hookBook.add = 0;
  hookBook.insert = 0;
  hookBook.discard = 0;
  hookBook.remove = 0;

  const rekeyEntity = spawnMarker(world, [-180, 90, 0], [1, 0.25, 0.15, 1], {
    component: HookedMarker,
    data: { key: 1, value: 0 },
  });
  hookBook.add += 1;
  recordMarkerInsert(rekeyEntity, 1);
  const addEntity = spawnMarker(world, [180, -90, 0], [0.15, 0.8, 1, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );

  const state: ComponentHooksState = {
    elapsed: 0,
    addEntity,
    rekeyEntity,
    added: false,
    rekeyed: false,
    removed: false,
  };

  world.addSystem(Update, {
    name: 'component-hooks-transitions',
    queries: [],
    fn: (world) => {
      state.elapsed += world.getResource(Time).delta;
      if (!state.added && state.elapsed >= HOOK_STEP) {
        world.addComponent(addEntity, { component: HookedMarker, data: { key: 2, value: 0 } }).unwrap();
        hookBook.add += 1;
        recordMarkerInsert(addEntity, 2);
        state.added = true;
      }
      if (!state.rekeyed && state.elapsed >= HOOK_STEP * 2) {
        const previous = world.get(rekeyEntity, HookedMarker).unwrap();
        recordMarkerDiscard(previous.key);
        world.set(rekeyEntity, HookedMarker, { key: 3, value: 1 }).unwrap();
        recordMarkerInsert(rekeyEntity, 3);
        state.rekeyed = true;
      }
      if (!state.removed && state.elapsed >= HOOK_STEP * 3) {
        const previous = world.get(addEntity, HookedMarker).unwrap();
        recordMarkerDiscard(previous.key);
        world.removeComponent(addEntity, HookedMarker).unwrap();
        hookBook.remove += 1;
        state.removed = true;
      }
    },
  }).unwrap();

  return state;
}

export function readComponentHooksState(
  world: World,
  state: ComponentHooksState,
): ComponentHooksSnapshot {
  return {
    elapsed: state.elapsed,
    add: hookBook.add,
    insert: hookBook.insert,
    discard: hookBook.discard,
    remove: hookBook.remove,
    indexSize: hookBook.index.size,
    rekey: world.get(state.rekeyEntity, HookedMarker).unwrap().key,
    remaining: world.get(state.addEntity, HookedMarker).ok ? 1 : 0,
  };
}
