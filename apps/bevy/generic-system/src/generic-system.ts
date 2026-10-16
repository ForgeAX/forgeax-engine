// Reproduction of Bevy's ecs/generic_system example.
//
// One generic cleanup factory is specialized for MenuClose and LevelUnload.
// The state transition remains explicit, while the query/command body is shared.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import {
  Time,
  Update,
  World,
  defineComponent,
  type Component,
  type ComponentSchema,
  type EntityHandle,
  type SystemDescriptor,
} from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import {
  getPreviousState,
  getState,
  setNextState,
  defineState,
  type StateTokenVariant,
} from '@forgeax/engine-state';
import { Transform } from '@forgeax/engine-scene';

export const AppState = defineState('GenericSystemAppState', ['menu', 'in-game'] as const);
export const TextToPrint = defineComponent('GenericSystemTextToPrint', {});
export const PrinterTick = defineComponent('GenericSystemPrinterTick', { ticks: 'f32' });
export const MenuClose = defineComponent('GenericSystemMenuClose', {});
export const LevelUnload = defineComponent('GenericSystemLevelUnload', {});

const MENU_CLOSE_X = -260;
const LEVEL_UNLOAD_X = 0;
const PERSISTENT_X = 260;

export interface GenericSystemState {
  elapsed: number;
  currentState: string;
  cleanupLog: string[];
  remaining: number;
}

export interface GenericSystemSnapshot {
  elapsed: number;
  currentState: string;
  cleanupLog: string[];
  remaining: number;
}

function spawnMarker(
  world: World,
  marker: Component<string, ComponentSchema>,
  pos: readonly [number, number, number],
  color: readonly [number, number, number, number],
): EntityHandle {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit(color));
  return world
    .spawn(
      { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [90, 90, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: marker, data: {} },
    )
    .unwrap();
}

function exiting(variant: StateTokenVariant<typeof AppState>) {
  return (world: World): boolean => {
    const previous = getPreviousState(world, AppState);
    const current = getState(world, AppState);
    return previous.ok && current.ok && previous.value === variant && current.value !== variant;
  };
}

function cleanupSystem<T extends Component<string, ComponentSchema>>(
  marker: T,
  leaving: StateTokenVariant<typeof AppState>,
  label: string,
  cleanupLog: string[],
): SystemDescriptor<readonly [{ readonly with: readonly [T] }]> {
  return {
    name: `generic-cleanup-${label}`,
    queries: [{ with: [marker] as const }],
    runIf: exiting(leaving),
    fn: (_world, queryResults, commands) => {
      for (const row of queryResults[0]) {
          commands.despawn(row.entity);
          cleanupLog.push(label);
      }
    },
  };
}

export function buildGenericSystemWorld(world: World): GenericSystemState {
  const cleanupLog: string[] = [];
  spawnMarker(world, MenuClose, [MENU_CLOSE_X, 0, 0], [0.15, 0.65, 1, 1]);
  spawnMarker(world, LevelUnload, [LEVEL_UNLOAD_X, 0, 0], [1, 0.35, 0.15, 1]);
  spawnMarker(world, TextToPrint, [PERSISTENT_X, 0, 0], [0.2, 0.9, 0.35, 1]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );

  const state: GenericSystemState = { elapsed: 0, currentState: 'menu', cleanupLog, remaining: 3 };
  let firstTransition = false;
  let secondTransition = false;
  world.addSystem(Update, {
    name: 'generic-state-transitions',
    queries: [],
    fn: (world) => {
      state.elapsed += world.getResource<typeof Time>(Time).delta;
      if (!firstTransition && state.elapsed >= 0.6) {
        firstTransition = true;
        setNextState(world, AppState, 'in-game');
      } else if (firstTransition && !secondTransition && state.elapsed >= 1.6) {
        secondTransition = true;
        setNextState(world, AppState, 'menu');
      }
    },
  }).unwrap();
  world.addSystem(Update, cleanupSystem(MenuClose, 'menu', 'menu-close', cleanupLog)).unwrap();
  world.addSystem(Update, cleanupSystem(LevelUnload, 'in-game', 'level-unload', cleanupLog)).unwrap();
  return state;
}

export function readGenericSystemState(world: World, state: GenericSystemState): GenericSystemSnapshot {
  const current = getState(world, AppState);
  state.currentState = current.ok ? current.value : 'unknown';
  state.remaining = 3 - state.cleanupLog.length;
  return {
    elapsed: state.elapsed,
    currentState: state.currentState,
    cleanupLog: [...state.cleanupLog],
    remaining: state.remaining,
  };
}
