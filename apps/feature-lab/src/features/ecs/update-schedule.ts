import { defineSystemSet, Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Update schedule ordering',
  catalog: 'Update schedule',
  kind: 'headless',
  summary:
    'world.update(delta) runs the Update schedule exactly once, honoring before/after, chained sets and runIf gates.',
  expect:
    'All checks pass: the run log is ordered by constraints, gated systems skip, and a before/after cycle is rejected.',
  run(checks) {
    const world = new World();
    const log: string[] = [];
    const sys = (
      name: string,
      extra: { after?: string[]; before?: string[]; runIf?: (w: World) => boolean } = {},
    ) => ({
      name,
      queries: [] as const,
      fn: () => {
        log.push(name);
      },
      ...extra,
    });
    checks.ok('add c after b', world.addSystem(Update, sys('c', { after: ['b'] })).ok);
    checks.ok('add a before b', world.addSystem(Update, sys('a', { before: ['b'] })).ok);
    checks.ok('add b', world.addSystem(Update, sys('b')).ok);
    world.insertResource('FLUpdatePaused', false);
    checks.ok(
      'add gated',
      world.addSystem(
        Update,
        sys('gated', { after: ['c'], runIf: (w) => !w.getResource<boolean>('FLUpdatePaused') }),
      ).ok,
    );
    const Chain = defineSystemSet({ name: 'fl-update-chain', chained: true });
    checks.ok(
      'addSystems chained',
      world.addSystems(Update, Chain, [sys('s1', { after: ['gated'] }), sys('s2'), sys('s3')]).ok,
    );
    checks.ok('update #1', world.update(1 / 60).ok);
    const order = (n: string) => log.indexOf(n);
    checks.ok('a < b < c', order('a') < order('b') && order('b') < order('c'), log.join(','));
    checks.ok(
      'chained s1 < s2 < s3',
      order('s1') < order('s2') && order('s2') < order('s3'),
      log.join(','),
    );
    checks.equal('each system once', log.length, 7);
    log.length = 0;
    world.insertResource('FLUpdatePaused', true);
    checks.ok('update #2', world.update(1 / 60).ok);
    checks.ok('gated skipped', !log.includes('gated') && log.length === 6, log.join(','));
    checks.ok('removeSystem', world.removeSystem(Update, 'a').ok);
    log.length = 0;
    world.update(1 / 60);
    checks.ok('removed system gone', !log.includes('a'));
    const cyc = new World();
    cyc.addSystem(Update, sys('x', { after: ['y'] }));
    const second = cyc.addSystem(Update, sys('y', { after: ['x'] }));
    const run = second.ok ? cyc.update(1 / 60) : second;
    checks.equal('cycle rejected', run.ok ? 'ok' : run.error.code, 'cyclic-dependency');
  },
});
