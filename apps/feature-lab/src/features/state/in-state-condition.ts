import { Update, World } from '@forgeax/engine/ecs';
import { defineState, inState, registerStatesPlugin, setNextState } from '@forgeax/engine/state';
import { defineFeature } from '../../lab/feature';

const FLGateGame = defineState('FLGateGame', ['paused', 'running'] as const);

export default defineFeature({
  title: 'inState run condition',
  catalog: '`inState` condition',
  kind: 'headless',
  summary:
    'inState(token, variant) returns a World predicate for runIf, gating systems without a second scheduler.',
  expect:
    'All checks pass: the gated system runs only in running, the predicate reads the current World, and it is false for a World without the state runtime.',
  run(checks) {
    const world = new World();
    const dispose = registerStatesPlugin(world);
    let ticks = 0;
    const running = inState(FLGateGame, 'running');
    world.addSystem(Update, {
      name: 'fl-gate-sim',
      queries: [],
      runIf: running,
      fn: () => {
        ticks += 1;
      },
    });
    world.update(1 / 60);
    checks.equal('skipped while paused', ticks, 0);
    checks.ok('predicate false while paused', !running(world));
    setNextState(world, FLGateGame, 'running');
    world.update(1 / 60);
    world.update(1 / 60);
    checks.ok('predicate true while running', running(world));
    checks.ok('runs while running', ticks >= 1, `ticks=${ticks}`);
    const before = ticks;
    setNextState(world, FLGateGame, 'paused');
    world.update(1 / 60);
    world.update(1 / 60);
    checks.equal('stops after pausing', ticks, before);
    let other = 'none';
    try {
      other = String(running(new World()));
    } catch (error) {
      other = (error as { code?: string }).code ?? 'thrown';
    }
    checks.equal('unregistered World predicate', other, 'false');
    dispose();
  },
});
