// Reproduction of Bevy's ecs/system_closure example.
//
// Bevy registers ordinary closures, closures with persistent local state, and
// closures that capture an outside value. ForgeaX keeps the same explicit
// capture boundary in SystemDescriptor.fn: the schedule owns invocation while
// the closure owns only the state it intentionally captures.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Time, Update, World, defineComponent, type EntityHandle } from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

export const SYSTEM_CLOSURE_STATE = 'bevySystemClosureState';

const TRACK_WIDTH = 520;
const SIMPLE_START = -TRACK_WIDTH / 2;
const STATEFUL_START = 0;
const CAPTURED_START = TRACK_WIDTH / 2;

export const SimpleClosureMarker = defineComponent('SystemClosureSimpleMarker', {});
export const StatefulClosureMarker = defineComponent('SystemClosureStatefulMarker', {});
export const CapturedClosureMarker = defineComponent('SystemClosureCapturedMarker', {});

export interface SystemClosureState {
  elapsed: number;
  simpleRuns: number;
  statefulRuns: number;
  capturedRuns: number;
  statefulValue: number;
  capturedValue: number;
  simpleEntity: EntityHandle;
  statefulEntity: EntityHandle;
  capturedEntity: EntityHandle;
}

export interface SystemClosureSnapshot {
  elapsed: number;
  simpleRuns: number;
  statefulRuns: number;
  capturedRuns: number;
  statefulValue: number;
  capturedValue: number;
  simpleX: number;
  statefulX: number;
  capturedX: number;
}

function spawnMarker(
  world: World,
  marker: typeof SimpleClosureMarker | typeof StatefulClosureMarker | typeof CapturedClosureMarker,
  pos: readonly [number, number, number],
  color: readonly [number, number, number, number],
): EntityHandle {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit(color));
  return world
    .spawn(
      { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [72, 72, 1] } },
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

function trackX(start: number, phase: number): number {
  return start + Math.sin(phase) * 180;
}

export function buildSystemClosureWorld(world: World): SystemClosureState {
  const simpleEntity = spawnMarker(world, SimpleClosureMarker, [SIMPLE_START, 140, 0], [0.15, 0.75, 1, 1]);
  const statefulEntity = spawnMarker(world, StatefulClosureMarker, [STATEFUL_START, 0, 0], [1, 0.35, 0.15, 1]);
  const capturedEntity = spawnMarker(world, CapturedClosureMarker, [CAPTURED_START, -140, 0], [0.35, 1, 0.3, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );

  const state: SystemClosureState = {
    elapsed: 0,
    simpleRuns: 0,
    statefulRuns: 0,
    capturedRuns: 0,
    statefulValue: 0,
    capturedValue: 0,
    simpleEntity,
    statefulEntity,
    capturedEntity,
  };
  world.insertResource(SYSTEM_CLOSURE_STATE, state);

  const outsideVariable = 7;
  let persistentValue = 0;

  world.addSystem(Update, {
    name: 'system-closure-clock',
    queries: [],
    fn: (world) => {
      state.elapsed += world.getResource(Time).delta;
    },
  }).unwrap();

  const simpleClosure = (): void => {
    state.simpleRuns += 1;
    setX(world, simpleEntity, trackX(SIMPLE_START, state.elapsed * 1.6));
  };
  world.addSystem(Update, {
    name: 'system-closure-simple',
    queries: [],
    fn: simpleClosure,
  }).unwrap();

  const statefulClosure = (): void => {
    persistentValue += 1;
    state.statefulRuns += 1;
    state.statefulValue = persistentValue;
    setX(world, statefulEntity, trackX(STATEFUL_START, persistentValue * 0.08));
  };
  world.addSystem(Update, {
    name: 'system-closure-stateful',
    queries: [],
    fn: statefulClosure,
  }).unwrap();

  const capturedClosure = (): void => {
    state.capturedRuns += 1;
    state.capturedValue = outsideVariable + state.elapsed;
    setX(world, capturedEntity, trackX(CAPTURED_START, state.capturedValue * 0.5));
  };
  world.addSystem(Update, {
    name: 'system-closure-captured',
    queries: [],
    fn: capturedClosure,
  }).unwrap();

  return state;
}

export function readSystemClosureState(world: World, state: SystemClosureState): SystemClosureSnapshot {
  const simple = world.get(state.simpleEntity, Transform);
  const stateful = world.get(state.statefulEntity, Transform);
  const captured = world.get(state.capturedEntity, Transform);
  return {
    elapsed: state.elapsed,
    simpleRuns: state.simpleRuns,
    statefulRuns: state.statefulRuns,
    capturedRuns: state.capturedRuns,
    statefulValue: state.statefulValue,
    capturedValue: state.capturedValue,
    simpleX: simple.ok ? (simple.value.pos[0] ?? Number.NaN) : Number.NaN,
    statefulX: stateful.ok ? (stateful.value.pos[0] ?? Number.NaN) : Number.NaN,
    capturedX: captured.ok ? (captured.value.pos[0] ?? Number.NaN) : Number.NaN,
  };
}
