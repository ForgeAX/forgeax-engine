import { defineComponent, World } from '@forgeax/engine/ecs';
import { createStateProjection } from '@forgeax/engine/ecs/projection';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Bounded change projection',
  catalog: 'Bounded change projection',
  kind: 'headless',
  summary:
    'createStateProjection gives a consumer a conservative work set of changed source indices; the consumer accepts a batch only after applying it.',
  expect:
    'All checks pass: the first read covers every entity, unchanged Worlds are current, writes and deletes reappear, and an unaccepted batch is re-offered.',
  run(checks) {
    const Hp = defineComponent('FLProjHp', { v: 'f32' });
    const world = new World();
    const es = [1, 2, 3].map((v) => world.spawn({ component: Hp, data: { v } }).unwrap());
    const projection = createStateProjection(world, [Hp]);
    const first = projection.read();
    checks.equal('first read covers all', first.indices.length, 3);
    checks.ok('membershipChanged on first read', first.membershipChanged);
    first.accept();
    checks.ok('current after accept', projection.isCurrent());
    checks.equal('quiet read is empty', projection.read().indices.length, 0);
    const e1 = es[1];
    if (e1 === undefined) return;
    world.set(e1, Hp, { v: 20 });
    checks.ok('stale after write', !projection.isCurrent());
    const dirty = projection.read();
    checks.ok(
      'written entity offered',
      dirty.indices.some((i) => projection.entity(i) === e1),
    );
    checks.ok('changed(entity, Hp)', projection.changed(e1, Hp));
    const again = projection.read();
    checks.ok(
      'unaccepted batch re-offered',
      again.indices.some((i) => projection.entity(i) === e1),
    );
    again.accept();
    const e0 = es[0];
    if (e0 === undefined) return;
    world.despawn(e0);
    const del = projection.read();
    checks.ok('deletion offered', del.indices.length >= 1);
    checks.ok(
      'deleted index resolves to undefined',
      del.indices.some((i) => projection.entity(i) === undefined),
    );
    del.accept();
    projection.invalidate();
    checks.ok('invalidate forces work', projection.read().indices.length >= 2);
  },
});
