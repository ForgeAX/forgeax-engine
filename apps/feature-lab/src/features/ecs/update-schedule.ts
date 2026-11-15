import type { SystemOrderReference } from '@forgeax/engine/ecs';
import { defineResource, defineSystem, defineSystemSet, Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

const resource1 = defineResource<boolean>('FLUpdatePaused');

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
      extra: {
        after?: SystemOrderReference[];
        before?: SystemOrderReference[];
        runIf?: (w: World) => boolean;
      } = {},
    ) =>
      defineSystem({
        name,
        queries: [] as const,
        fn: () => {
          log.push(name);
        },
        ...extra,
      });
    const systemToken3 = sys('b');
    const systemToken1 = sys('c', { after: [systemToken3] });
    checks.ok('add c after b', world.addSystem(Update, systemToken1).ok);
    const systemToken2 = sys('a', { before: [systemToken3] });
    checks.ok('add a before b', world.addSystem(Update, systemToken2).ok);
    checks.ok('add b', world.addSystem(Update, systemToken3).ok);
    world.insertResource(resource1, false);
    const systemToken4 = sys('gated', {
      after: [systemToken1],
      runIf: (w) => !w.getResource(resource1),
    });
    checks.ok('add gated', world.addSystem(Update, systemToken4).ok);
    const Chain = defineSystemSet({ name: 'fl-update-chain', chained: true });
    checks.ok(
      'addSystems chained',
      world.addSystems(Update, Chain, [sys('s1', { after: [systemToken4] }), sys('s2'), sys('s3')])
        .ok,
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
    world.insertResource(resource1, true);
    checks.ok('update #2', world.update(1 / 60).ok);
    checks.ok('gated skipped', !log.includes('gated') && log.length === 6, log.join(','));
    checks.ok('removeSystem', world.removeSystem(Update, systemToken2).ok);
    log.length = 0;
    world.update(1 / 60);
    checks.ok('removed system gone', !log.includes('a'));
    const cyc = new World();
    const cycle: SystemOrderReference[] = [];
    const systemToken5 = sys('x', { after: cycle });
    cyc.addSystem(Update, systemToken5);
    const systemToken6 = sys('y', { after: [systemToken5] });
    cycle.push(systemToken6);
    const second = cyc.addSystem(Update, systemToken6);
    const run = second.ok ? cyc.update(1 / 60) : second;
    checks.equal('cycle rejected', run.ok ? 'ok' : run.error.code, 'cyclic-dependency');
  },
});
