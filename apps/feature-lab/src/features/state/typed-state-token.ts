import { World } from '@forgeax/engine/ecs';
import {
  defineState,
  getState,
  registerStatesPlugin,
  type StateTokenVariant,
  setNextState,
} from '@forgeax/engine/state';
import { defineFeature } from '../../lab/feature';

const FLTokenPhase = defineState('FLTokenPhase', ['menu', 'play', 'over'] as const);

function code(body: () => unknown): string {
  try {
    body();
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'thrown';
  }
}

export default defineFeature({
  title: 'Typed StateToken',
  catalog: 'Typed StateToken',
  kind: 'headless',
  summary:
    'defineState creates a branded token with a closed variant tuple; the first variant is the default, and invalid variants fail at compile time and at runtime.',
  expect:
    'All checks pass: default is menu, tokens are World-local, invalid variants and unregistered Worlds give closed codes, and duplicate or empty definitions throw.',
  run(checks) {
    const phase: StateTokenVariant<typeof FLTokenPhase> = 'play';
    checks.equal('name', FLTokenPhase.name, 'FLTokenPhase');
    checks.equal('variants', [...FLTokenPhase.variants], ['menu', 'play', 'over']);
    checks.equal('defaultValue', FLTokenPhase.defaultValue, 'menu');
    const bare = new World();
    const unreg = getState(bare, FLTokenPhase);
    checks.equal('unregistered World', unreg.ok ? 'ok' : unreg.error.code, 'state-not-registered');
    const world = new World();
    const dispose = registerStatesPlugin(world);
    checks.equal('default state', getState(world, FLTokenPhase).unwrap(), 'menu');
    checks.ok('setNextState(play)', setNextState(world, FLTokenPhase, phase).ok);
    // @ts-expect-error 'pause' is not a declared variant.
    const bad = setNextState(world, FLTokenPhase, 'pause');
    checks.equal('invalid variant', bad.ok ? 'ok' : bad.error.code, 'invalid-variant');
    world.update(1 / 60);
    checks.equal('World A in play', getState(world, FLTokenPhase).unwrap(), 'play');
    const other = new World();
    const disposeOther = registerStatesPlugin(other);
    checks.equal('World B still default', getState(other, FLTokenPhase).unwrap(), 'menu');
    checks.equal(
      'duplicate defineState',
      code(() => defineState('FLTokenPhase', ['a'] as const)),
      'state-already-defined',
    );
    checks.equal(
      'empty variants',
      code(() => defineState('FLTokenEmpty', [] as const)),
      'state-default-required',
    );
    checks.equal(
      'duplicate variants',
      code(() => defineState('FLTokenDup', ['a', 'a'] as const)),
      'state-default-required',
    );
    disposeOther();
    dispose();
    const after = getState(world, FLTokenPhase);
    checks.equal(
      'disposer removes runtime',
      after.ok ? 'ok' : after.error.code,
      'state-not-registered',
    );
  },
});
