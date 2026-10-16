import { defineComponent, Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'World poison and rebuild',
  catalog: 'World poison',
  kind: 'headless',
  summary:
    'A throwing system poisons the World: the failing update returns system-failed, later calls return world-poisoned, and recovery is a new World.',
  expect:
    'All checks pass: health flips to poisoned with a fault, mutations are refused, and a replacement World has a fresh identity and replays state.',
  run(checks) {
    const Hp = defineComponent('FLPoisonHp', { v: 'f32' });
    const build = () => {
      const w = new World();
      w.addSystem(Update, {
        name: 'fl-poison-boom',
        queries: [{ write: [Hp] }],
        fn: (world, [rows]) => {
          for (const row of rows) row.mut(Hp).v -= 1;
          if (world.hasResource('FLPoisonTrigger')) throw new Error('boom');
        },
      });
      return w;
    };
    const world = build();
    world.spawn({ component: Hp, data: { v: 10 } }).unwrap();
    checks.equal('healthy initially', world.execution.health, 'healthy');
    checks.ok('normal update', world.update(1 / 60).ok);
    world.insertResource('FLPoisonTrigger', true);
    const failed = world.update(1 / 60);
    checks.equal('first failure', failed.ok ? 'ok' : failed.error.code, 'system-failed');
    if (!failed.ok && failed.error.code === 'system-failed')
      checks.equal('failing system named', failed.error.detail.systemName, 'fl-poison-boom');
    checks.equal('health poisoned', world.execution.health, 'poisoned');
    checks.ok('fault recorded', world.execution.fault !== null);
    const next = world.update(1 / 60);
    checks.equal('update refused', next.ok ? 'ok' : next.error.code, 'world-poisoned');
    const spawn = world.spawn({ component: Hp, data: { v: 1 } });
    checks.equal('spawn refused', spawn.ok ? 'ok' : spawn.error.code, 'world-poisoned');
    const fresh = build();
    checks.ok('new identity', fresh.identity !== world.identity);
    fresh.spawn({ component: Hp, data: { v: 9 } }).unwrap();
    checks.ok('rebuilt World updates', fresh.update(1 / 60).ok);
    checks.equal('rebuilt healthy', fresh.execution.health, 'healthy');
  },
});
