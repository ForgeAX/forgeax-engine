import { describe, expect, it, vi } from 'vitest';
import { World } from '@forgeax/engine-ecs';
import { Context } from '@forgeax/engine-plugin';
import { registerStatesPlugin } from '@forgeax/engine-state';
import { installGameplayState } from '../assets/plugins/gameplay-state';

function installState(world: World, options: Omit<Parameters<typeof installGameplayState>[0], 'context' | 'world'>) {
  registerStatesPlugin(world);
  return installGameplayState({ context: new Context(), world, ...options });
}

describe('game-default victory replay lifecycle', () => {
  it('preserves counterattack Defeat precedence when it follows extraction Victory in one frame', () => {
    const world = new World();
    const state = installState(world, { reset: vi.fn() });
    world.update(1 / 60).unwrap();

    state.requestVictory();
    state.requestDefeat();
    world.update(1 / 60).unwrap();

    expect(state.snapshot()).toMatchObject({
      phase: 'Defeat',
      victoryTransitions: 0,
      defeatTransitions: 1,
    });
  });

  it('freezes Play simulation in Victory and re-enters Play through Reset twice', () => {
    const world = new World();
    const reset = vi.fn();
    const onPhaseChange = vi.fn();
    const state = installState(world, { reset, onPhaseChange });

    world.update(1 / 60).unwrap();
    const playTicks = state.snapshot().fixedTicks;

    state.requestVictory();
    world.update(1 / 60).unwrap();
    expect(state.snapshot()).toMatchObject({ phase: 'Victory', fixedTicks: playTicks, victoryTransitions: 1, resetTransitions: 0 });
    world.update(1 / 60).unwrap();
    expect(state.snapshot().fixedTicks).toBe(playTicks);

    state.requestReset();
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    expect(state.snapshot()).toMatchObject({ phase: 'Play', victoryTransitions: 1, resetTransitions: 1 });
    expect(reset).toHaveBeenCalledTimes(1);

    state.requestVictory();
    world.update(1 / 60).unwrap();
    state.requestReset();
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    expect(state.snapshot()).toMatchObject({ phase: 'Play', victoryTransitions: 2, resetTransitions: 2 });
    expect(reset).toHaveBeenCalledTimes(2);
    expect(onPhaseChange.mock.calls.map(([phase]) => phase)).toEqual([
      'Play', 'Victory', 'Reset', 'Play', 'Victory', 'Reset', 'Play',
    ]);
  });

  it('freezes the same Play simulation in Defeat and replays through Reset', () => {
    const world = new World();
    const reset = vi.fn();
    const state = installState(world, { reset });
    world.update(1 / 60).unwrap();
    const playTicks = state.snapshot().fixedTicks;

    state.requestDefeat();
    world.update(1 / 60).unwrap();
    expect(state.snapshot()).toMatchObject({
      phase: 'Defeat',
      fixedTicks: playTicks,
      defeatTransitions: 1,
    });
    world.update(1 / 60).unwrap();
    expect(state.snapshot().fixedTicks).toBe(playTicks);

    state.requestReset();
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    expect(state.snapshot()).toMatchObject({ phase: 'Play', defeatTransitions: 1, resetTransitions: 1 });
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
