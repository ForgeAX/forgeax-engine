import {
  defineComponent,
  defineResource,
  defineSystem,
  FixedTime,
  FixedUpdate,
  Time,
  Update,
  World,
} from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

const resource1 = defineResource<{ total: number }>('FLAuthorityScore');

export default defineFeature({
  title: 'World state authority',
  catalog: 'World state authority',
  kind: 'headless',
  summary:
    'One World owns entities, components, queries, systems, resources and both clocks; every read and write goes through it.',
  expect:
    'All checks pass: entity, system, resource and Time/FixedTime facts are all observed through the same World.',
  run(checks) {
    const Hp = defineComponent('FLAuthorityHp', { value: 'f32' });
    const world = new World();
    const a = world.spawn({ component: Hp, data: { value: 10 } });
    const b = world.spawn({ component: Hp, data: { value: 20 } });
    checks.ok('spawn returns Result ok', a.ok && b.ok);
    world.insertResource(resource1, { total: 0 });
    const systemToken1 = defineSystem({
      name: 'fl-authority-sum',
      queries: [{ read: [Hp] }],
      fn: (world, [rows]) => {
        let sum = 0;
        for (const row of rows) sum += row.get(Hp).value;
        world.getResource(resource1).total = sum;
      },
    });
    const system = world.addSystem(Update, systemToken1);
    checks.ok('addSystem(Update) ok', system.ok);
    const systemToken2 = defineSystem({
      name: 'fl-authority-fixed',
      queries: [],
      fn: () => undefined,
    });
    const fixed = world.addSystem(FixedUpdate, systemToken2);
    checks.ok('addSystem(FixedUpdate) ok', fixed.ok);
    checks.ok('update ok', world.update(1 / 30).ok);
    checks.equal('resource written by system', world.getResource(resource1).total, 30);
    checks.near('Time.delta owned by World', world.getResource(Time).delta, 1 / 30);
    checks.near('Time.elapsed owned by World', world.getResource(Time).elapsed, 1 / 30);
    checks.equal('FixedTime.tick advanced by World', world.getResource(FixedTime).tick, 2);
    const info = world.inspect();
    checks.equal('entityCount', info.entityCount, 2);
    checks.equal('systemCount', info.systemCount, 2);
    checks.ok(
      'resource key listed',
      info.resourceKeys.includes('FLAuthorityScore'),
      info.resourceKeys.join(','),
    );
    checks.ok('component active', info.activeComponents.includes('FLAuthorityHp'));
    if (a.ok) checks.ok('despawn ok', world.despawn(a.value).ok);
    checks.equal('entityCount after despawn', world.inspect().entityCount, 1);
    if (a.ok) {
      const stale = world.get(a.value, Hp);
      checks.equal('stale entity read', stale.ok ? 'ok' : stale.error.code, 'stale-entity');
    }
    const other = new World();
    checks.equal('second World is independent', other.inspect().entityCount, 0);
    checks.ok('identities differ', other.identity !== world.identity);
  },
});
