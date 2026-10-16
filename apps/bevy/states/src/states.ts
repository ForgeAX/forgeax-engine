import { Time, Update, type World } from '@forgeax/engine-ecs';
import { addOnEnter, addOnExit, defineState, getState, setNextState } from '@forgeax/engine-state';

export const AppState = defineState('AppState', ['menu', 'in-game'] as const);

export interface StatesResult {
  enterCalls: string[];
  exitCalls: string[];
  currentState: string;
}

export function buildStatesWorld(world: World): { getState: () => StatesResult } {
  const enterCalls: string[] = [];
  const exitCalls: string[] = [];

  addOnEnter(AppState, 'menu', () => {
    enterCalls.push('menu');
  });
  addOnExit(AppState, 'menu', () => {
    exitCalls.push('menu');
  });
  addOnEnter(AppState, 'in-game', () => {
    enterCalls.push('in-game');
  });
  addOnExit(AppState, 'in-game', () => {
    exitCalls.push('in-game');
  });

  let accumulator = 0;
  let toggled = false;
  world.addSystem(Update, {
    name: 'state-transition',
    queries: [],
    fn: (_world) => {
      const time = _world.getResource(Time);
      accumulator += time.delta;
      if (accumulator > 0.5 && !toggled) {
        toggled = true;
        setNextState(_world, AppState, 'in-game');
      }
    },
  });

  return {
    getState: () => {
      const result = getState(world, AppState);
      const currentState = result.ok ? result.value : 'unknown';
      return {
        enterCalls: [...enterCalls],
        exitCalls: [...exitCalls],
        currentState,
      };
    },
  };
}