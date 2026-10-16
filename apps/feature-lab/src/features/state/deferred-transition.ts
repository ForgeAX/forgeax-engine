import { Update, World } from '@forgeax/engine/ecs';
import {
  addOnEnter,
  defineState,
  getPreviousState,
  getState,
  registerStatesPlugin,
  setNextState,
  setNextStateForce,
} from '@forgeax/engine/state';
import { defineFeature } from '../../lab/feature';

const FLDeferLevel = defineState('FLDeferLevel', ['a', 'b', 'c'] as const);

export default defineFeature({
  title: 'Deferred state transition',
  catalog: 'Deferred state transition',
  kind: 'headless',
  summary:
    'setNextState only records a request; the transition system flips State during the next world.update, and a throwing hook does not roll the flip back.',
  expect:
    'All checks pass: state is unchanged before update, flips during update, same-state is a no-op unless forced, and a throwing OnEnter leaves the new state committed.',
  run(checks) {
    const world = new World();
    const dispose = registerStatesPlugin(world);
    const seen: string[] = [];
    world.addSystem(Update, {
      name: 'fl-defer-observer',
      queries: [],
      after: ['transitionStates'],
      fn: (world) => void seen.push(getState(world, FLDeferLevel).unwrap()),
    });
    let entered = 0;
    const offB = addOnEnter(FLDeferLevel, 'b', () => {
      entered += 1;
    });
    setNextState(world, FLDeferLevel, 'b');
    checks.equal('unchanged before update', getState(world, FLDeferLevel).unwrap(), 'a');
    checks.ok('update ok', world.update(1 / 60).ok);
    checks.equal('flipped during update', getState(world, FLDeferLevel).unwrap(), 'b');
    checks.equal('observer after transition sees b', seen.at(-1), 'b');
    checks.equal('previous state', getPreviousState(world, FLDeferLevel).unwrap(), 'a');
    setNextState(world, FLDeferLevel, 'b');
    world.update(1 / 60);
    checks.equal('same-state is a no-op', entered, 1);
    setNextStateForce(world, FLDeferLevel, 'b');
    world.update(1 / 60);
    checks.equal('forced same-state re-enters', entered, 2);
    offB();
    const offC = addOnEnter(FLDeferLevel, 'c', () => {
      throw new Error('fl hook failure');
    });
    setNextState(world, FLDeferLevel, 'c');
    const failed = world.update(1 / 60);
    checks.equal(
      'hook failure surfaces as system failure',
      failed.ok ? 'ok' : failed.error.code,
      'system-failed',
    );
    checks.equal('flip not rolled back', getState(world, FLDeferLevel).unwrap(), 'c');
    offC();
    dispose();
  },
});
