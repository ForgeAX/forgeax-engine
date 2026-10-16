// apps/bevy/run-conditions - reproduction of Bevy's ecs/run_conditions example.
//
// Bevy mapping:
//   - resource_exists::<InputCounter>.or_else(has_user_input) -> a set-level
//     `runIf` that opens after the clock reaches UNLOCK_SECONDS.
//   - `.and_then(...)` / closure run condition -> the pulse system's own
//     system-level `runIf`, which short-circuits after the first pulse.
//   - `time_passed(2.0)` -> the same World-owned Time resource drives the gate;
//     no app-side clock or callback loop is introduced.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import {
  Time,
  Update,
  World,
  defineComponent,
  defineSystemSet,
  type EntityHandle,
} from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

export const RUN_CONDITION_STATE = 'bevyRunConditionsState';
export const UNLOCK_SECONDS = 2;

const ALWAYS_SPEED = 110;
const GATED_SPEED = 150;
const TRACK_WIDTH = 520;

export const AlwaysMarker = defineComponent('RunConditionsAlwaysMarker', {});
export const GatedMarker = defineComponent('RunConditionsGatedMarker', {});

export interface RunConditionState {
  elapsed: number;
  unlocked: boolean;
  skippedFrames: number;
  alwaysRuns: number;
  gatedRuns: number;
  pulseRuns: number;
  alwaysEntity: EntityHandle;
  gatedEntity: EntityHandle;
}

export interface RunConditionSnapshot {
  elapsed: number;
  unlocked: boolean;
  skippedFrames: number;
  alwaysRuns: number;
  gatedRuns: number;
  pulseRuns: number;
  alwaysX: number;
  gatedX: number;
}

function spawnMarker(
  world: World,
  marker: typeof AlwaysMarker | typeof GatedMarker,
  pos: readonly [number, number, number],
  color: readonly [number, number, number, number],
): EntityHandle {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit(color),
  );
  return world
    .spawn(
      { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [72, 72, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: marker, data: {} },
    )
    .unwrap();
}

function wrappedTrack(elapsed: number, speed: number, startElapsed: number): number {
  const distance = Math.max(0, elapsed - startElapsed) * speed;
  return -TRACK_WIDTH / 2 + (distance % TRACK_WIDTH);
}

function setX(world: World, entity: EntityHandle, x: number): void {
  const current = world.get(entity, Transform).unwrap();
  world.set(entity, Transform, {
    pos: [x, current.pos[1] ?? 0, current.pos[2] ?? 0],
  }).unwrap();
}

export function buildRunConditionsWorld(world: World): RunConditionState {
  const alwaysEntity = spawnMarker(world, AlwaysMarker, [-TRACK_WIDTH / 2, 120, 0], [0.15, 0.75, 1, 1]);
  const gatedEntity = spawnMarker(world, GatedMarker, [-TRACK_WIDTH / 2, -120, 0], [1, 0.35, 0.15, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );

  const state: RunConditionState = {
    elapsed: 0,
    unlocked: false,
    skippedFrames: 0,
    alwaysRuns: 0,
    gatedRuns: 0,
    pulseRuns: 0,
    alwaysEntity,
    gatedEntity,
  };
  world.insertResource(RUN_CONDITION_STATE, state);

  world.addSystem(Update, {
    name: 'run-conditions-clock',
    queries: [],
    fn: (world) => {
      const delta = world.getResource(Time).delta;
      state.elapsed += delta;
      state.unlocked = state.elapsed >= UNLOCK_SECONDS;
      if (!state.unlocked) state.skippedFrames += 1;
    },
  }).unwrap();

  world.addSystem(Update, {
    name: 'run-conditions-always',
    queries: [],
    fn: () => {
      state.alwaysRuns += 1;
      setX(world, alwaysEntity, wrappedTrack(state.elapsed, ALWAYS_SPEED, 0));
    },
  }).unwrap();

  const Gated = defineSystemSet({
    name: 'run-conditions-gated',
    runIf: (world) => world.getResource<RunConditionState>(RUN_CONDITION_STATE).unlocked,
  });
  const gatedMotion = {
    name: 'run-conditions-gated-motion',
    queries: [],
    fn: () => {
      state.gatedRuns += 1;
      setX(world, gatedEntity, wrappedTrack(state.elapsed, GATED_SPEED, UNLOCK_SECONDS));
    },
  } as const;
  const gatedPulse = {
    name: 'run-conditions-pulse-once',
    queries: [],
    runIf: (world: World) => {
      const state = world.getResource<RunConditionState>(RUN_CONDITION_STATE);
      return state.gatedRuns > 0 && state.pulseRuns === 0;
    },
    fn: () => {
      state.pulseRuns += 1;
    },
  } as const;
  world.addSystems(Update, Gated, [gatedMotion, gatedPulse]).unwrap();

  return state;
}

export function readRunConditionState(world: World, state: RunConditionState): RunConditionSnapshot {
  const always = world.get(state.alwaysEntity, Transform);
  const gated = world.get(state.gatedEntity, Transform);
  return {
    elapsed: state.elapsed,
    unlocked: state.unlocked,
    skippedFrames: state.skippedFrames,
    alwaysRuns: state.alwaysRuns,
    gatedRuns: state.gatedRuns,
    pulseRuns: state.pulseRuns,
    alwaysX: always.ok ? (always.value.pos[0] ?? Number.NaN) : Number.NaN,
    gatedX: gated.ok ? (gated.value.pos[0] ?? Number.NaN) : Number.NaN,
  };
}
