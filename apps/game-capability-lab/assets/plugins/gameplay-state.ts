import {
  FixedTime,
  FixedUpdate,
  Update,
  type World,
} from '@forgeax/engine-ecs';
import {
  addOnEnter,
  defineState,
  getState,
  inState,
  setNextState,
  type StateErrorCode,
} from '@forgeax/engine-state';
import type { Context } from '@forgeax/engine-plugin';

export const GameState = defineState('GameDefaultPhase', ['Play', 'Victory', 'Defeat', 'Reset'] as const);
export const GAMEPLAY_STATE_WITNESS_KEY = 'gameDefaultStateWitness';

export type GameplayPhase = 'Play' | 'Victory' | 'Defeat' | 'Reset';

export interface GameplayStateWitness {
  phase: GameplayPhase | 'unknown';
  updateTicks: number;
  fixedTicks: number;
  simulationSeconds: number;
  victoryTransitions: number;
  defeatTransitions: number;
  resetTransitions: number;
  lastErrorCode?: StateErrorCode;
}

export interface GameplayStateHandle {
  requestVictory(): void;
  requestDefeat(): void;
  requestReset(): void;
  requestInvalid(): StateErrorCode | undefined;
  snapshot(): GameplayStateWitness;
}

export interface GameplayStateContext {
  context: Context;
  world: World;
  reset: () => void;
  onTerminal?: () => void;
  onPhaseChange?: (phase: GameplayPhase) => void;
}

export function installGameplayState(ctx: GameplayStateContext): GameplayStateHandle {
  const initialWitness: GameplayStateWitness = {
    phase: 'Play',
    updateTicks: 0,
    fixedTicks: 0,
    simulationSeconds: 0,
    victoryTransitions: 0,
    defeatTransitions: 0,
    resetTransitions: 0,
  };
  ctx.context.effect(() => {
    ctx.world.insertResource(GAMEPLAY_STATE_WITNESS_KEY, initialWitness);
    return () => {
      ctx.world.removeResource(GAMEPLAY_STATE_WITNESS_KEY);
    };
  }, 'game-default/state-witness');

  const witness = (): GameplayStateWitness => ctx.world.getResource<GameplayStateWitness>(GAMEPLAY_STATE_WITNESS_KEY);
  const patchWitness = (patch: Partial<GameplayStateWitness>): void => {
    ctx.world.insertResource(GAMEPLAY_STATE_WITNESS_KEY, { ...witness(), ...patch });
  };

  const request = (variant: GameplayPhase): void => {
    const result = setNextState(ctx.world, GameState, variant);
    if (!result.ok) patchWitness({ lastErrorCode: result.error.code });
  };

  ctx.onPhaseChange?.('Play');
  ctx.context.effect(() => {
    const disposers = [
      addOnEnter(GameState, 'Play', () => ctx.onPhaseChange?.('Play')),
      addOnEnter(GameState, 'Victory', () => {
        ctx.onTerminal?.();
        patchWitness({ victoryTransitions: witness().victoryTransitions + 1 });
        ctx.onPhaseChange?.('Victory');
      }),
      addOnEnter(GameState, 'Defeat', () => {
        ctx.onTerminal?.();
        patchWitness({ defeatTransitions: witness().defeatTransitions + 1 });
        ctx.onPhaseChange?.('Defeat');
      }),
      addOnEnter(GameState, 'Reset', (world) => {
        patchWitness({ resetTransitions: witness().resetTransitions + 1 });
        ctx.onPhaseChange?.('Reset');
        ctx.reset();
        const result = setNextState(world, GameState, 'Play');
        if (!result.ok) patchWitness({ lastErrorCode: result.error.code });
      }),
    ];
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'game-default/state-hooks');

  ctx.context.effect(() => {
    ctx.world.addSystem(Update, {
      name: 'game-state-witness',
      queries: [],
      after: ['transitionStates'],
      before: [FixedUpdate],
      fn: () => {
        const current = getState(ctx.world, GameState);
        patchWitness({
          updateTicks: witness().updateTicks + 1,
          phase: current.ok && (current.value === 'Play' || current.value === 'Victory' || current.value === 'Defeat' || current.value === 'Reset') ? current.value : 'unknown',
        });
      },
    }).unwrap();
    ctx.world.addSystem(FixedUpdate, {
      name: 'game-fixed-simulation',
      queries: [],
      runIf: inState(GameState, 'Play'),
      fn: (world) => {
        const fixed = world.getResource(FixedTime);
        const current = witness();
        patchWitness({ fixedTicks: fixed.tick, simulationSeconds: current.simulationSeconds + fixed.delta });
      },
    }).unwrap();
    return () => {
      ctx.world.removeSystem(FixedUpdate, 'game-fixed-simulation');
      ctx.world.removeSystem(Update, 'game-state-witness');
    };
  }, 'game-default/state-systems');

  return {
    requestVictory() { request('Victory'); },
    requestDefeat() { request('Defeat'); },
    requestReset() { request('Reset'); },
    requestInvalid() {
      const result = setNextState(ctx.world, GameState, 'NotARealPhase' as never);
      if (result.ok) return undefined;
      patchWitness({ lastErrorCode: result.error.code });
      return result.error.code;
    },
    snapshot() { return { ...witness() }; },
  };
}
