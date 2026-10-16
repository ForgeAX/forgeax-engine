import { defineComponent, World } from '@forgeax/engine/ecs';
import {
  defineState,
  despawnOnEnter,
  despawnOnExit,
  registerStatesPlugin,
  setNextState,
} from '@forgeax/engine/state';
import { defineFeature } from '../../lab/feature';

const FLScopeMode = defineState('FLScopeMode', ['lobby', 'match', 'results'] as const);

export default defineFeature({
  title: 'State-scoped entities',
  catalog: 'State-scoped entities',
  kind: 'headless',
  summary:
    'despawnOnExit / despawnOnEnter mark entities that the transition removes; unscoped entities persist across states.',
  expect:
    'All checks pass: exit-scoped lobby UI dies on leaving lobby, enter-scoped entities die on entering results, unscoped entities survive, and a second marker for the same token is rejected.',
  run(checks) {
    const Tag = defineComponent('FLScopeTag', { id: 'u32' });
    const world = new World();
    const dispose = registerStatesPlugin(world);
    const spawn = (id: number) => world.spawn({ component: Tag, data: { id } }).unwrap();
    const lobbyUi = spawn(1);
    const matchBall = spawn(2);
    const persistent = spawn(3);
    const alive = (e: typeof lobbyUi) => world.get(e, Tag).ok;
    despawnOnExit(world, lobbyUi, FLScopeMode, 'lobby');
    despawnOnEnter(world, matchBall, FLScopeMode, 'results');
    let second = 'ok';
    try {
      despawnOnExit(world, lobbyUi, FLScopeMode, 'match');
    } catch (error) {
      second = (error as { code?: string }).code ?? 'thrown';
    }
    checks.equal('second marker for the same token throws', second, 'component-already-present');
    setNextState(world, FLScopeMode, 'match');
    checks.ok('still alive before update', alive(lobbyUi));
    world.update(1 / 60);
    checks.ok('lobby UI despawned on exit', !alive(lobbyUi));
    checks.ok('ball survives entering match', alive(matchBall));
    setNextState(world, FLScopeMode, 'results');
    world.update(1 / 60);
    checks.ok('ball despawned on entering results', !alive(matchBall));
    checks.ok('unscoped entity persists', alive(persistent));
    dispose();
  },
});
