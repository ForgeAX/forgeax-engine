import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  getState,
  registerStatesPlugin,
  setNextState,
  setNextStateForce,
} from '@forgeax/engine-state';
import { expect, it, vi } from 'vitest';
import type { HudHandles } from '../hud';
import { GAME_PROGRESS_KEY } from '../resources';
import { GameState, wireStates } from '../state-lifecycle';

// The state owner and World execute unchanged. Visual/gameplay bodies are
// irrelevant to installation lifetime; the actual HUD timer remains active.
vi.mock('../spawn/spawn-player', async () => {
  const { ok } = await import('@forgeax/engine-types');
  return {
    spawnPlayer: (world: World) =>
      ok({
        parent: world.spawn().unwrap(),
        sceneRoot: world.spawn().unwrap(),
        animationPlayer: world.spawn().unwrap(),
      }),
  };
});
vi.mock('../spawn/spawn-level', () => ({ LEVEL_HALF: 10, spawnLevel: () => [] }));
vi.mock('../spawn/spawn-core', () => ({
  CORE_POSITIONS: [],
  spawnCore: () => {
    throw new Error('empty level');
  },
}));
vi.mock('../spawn/spawn-guardian', () => ({
  GUARDIAN_SPAWNS: [],
  spawnGuardian: () => {
    throw new Error('empty level');
  },
}));
vi.mock('../spawn/spawn-portal', () => ({ spawnPortal: (world: World) => world.spawn().unwrap() }));
vi.mock('../systems/player-move', async () => {
  const { defineSystem } = await import('@forgeax/engine-ecs');
  return {
    createPlayerMoveSignal: () => ({}),
    createMoveSystem: () => defineSystem({ name: 'player-move', queries: [], fn() {} }),
  };
});
vi.mock('../systems/player-anim', async () => {
  const { defineSystem } = await import('@forgeax/engine-ecs');
  return { createAnimSystem: () => defineSystem({ name: 'player-anim', queries: [], fn() {} }) };
});
vi.mock('../systems/core-spin', async () => {
  const { defineSystem } = await import('@forgeax/engine-ecs');
  return { createSpinSystem: () => defineSystem({ name: 'core-spin', queries: [], fn() {} }) };
});
vi.mock('../systems/core-collect', async () => {
  const { defineSystem } = await import('@forgeax/engine-ecs');
  return {
    createCollectSystem: () => defineSystem({ name: 'core-collect', queries: [], fn() {} }),
  };
});
vi.mock('../systems/portal-activate', async () => {
  const { defineSystem } = await import('@forgeax/engine-ecs');
  return {
    createPortalSystem: () => defineSystem({ name: 'portal-activate', queries: [], fn() {} }),
  };
});
vi.mock('../systems/guardian-ai', async () => {
  const { defineSystem } = await import('@forgeax/engine-ecs');
  return {
    guardianWaypoints: () => [],
    createGuardianAISystem: () => defineSystem({ name: 'guardian-ai', queries: [], fn() {} }),
  };
});
vi.mock('../systems/guardian-hit', async () => {
  const { defineSystem } = await import('@forgeax/engine-ecs');
  return {
    createGuardianHitSystem: () => defineSystem({ name: 'guardian-hit', queries: [], fn() {} }),
  };
});
vi.mock('../systems/win-lose-arbiter', async () => {
  const { defineSystem } = await import('@forgeax/engine-ecs');
  return {
    createArbiterSystem: () => defineSystem({ name: 'win-lose-arbiter', queries: [], fn() {} }),
  };
});
vi.mock('../systems/debug-overlay', async () => {
  const { defineSystem } = await import('@forgeax/engine-ecs');
  return {
    createDebugOverlaySystem: () => defineSystem({ name: 'debug-overlay', queries: [], fn() {} }),
  };
});
vi.mock('../systems/audio-cue', async () => {
  const { defineSystem } = await import('@forgeax/engine-ecs');
  return { createAudioCueSystem: () => defineSystem({ name: 'audio-cue', queries: [], fn() {} }) };
});

it('retires each Play run through Win and Lose and starts one timer on replay', async () => {
  const assets = new AssetRegistry({ shaderRegistry: {} as never });
  const world = new World({ assets });
  registerStatesPlugin(world);
  const hud = {
    container: { style: {} },
    scoreEl: {},
    healthEl: {},
    timerEl: {},
  } as unknown as HudHandles;
  wireStates(
    { world } as Parameters<typeof wireStates>[0],
    assets,
    0 as never,
    0 as never,
    false,
    hud,
    {} as never,
    undefined,
    world.spawn().unwrap(),
  );
  const pumpToPlay = () => {
    for (let index = 0; index < 8; index++) {
      world.update(1 / 60).unwrap();
      const state = getState(world, GameState);
      if (state.ok && state.value === 'Play') return;
    }
    throw new Error('state transitions did not reach Play');
  };
  setNextStateForce(world, GameState, 'Title').unwrap();
  pumpToPlay();
  world.update(1 / 60).unwrap();
  const installed = world.inspect().systemCount;
  for (const outcome of ['Win', 'Lose'] as const) {
    setNextState(world, GameState, outcome).unwrap();
    world.update(1 / 60).unwrap();
    expect(world.inspect().systems.some((system) => system.name === 'hud-timer')).toBe(false);
    pumpToPlay();
    expect(world.inspect().systemCount).toBe(installed);
    const before = world.getResource(GAME_PROGRESS_KEY).elapsed;
    world.update(1 / 60).unwrap();
    expect(world.getResource(GAME_PROGRESS_KEY).elapsed - before).toBeCloseTo(1 / 60, 12);
  }
  await Promise.resolve();
});
