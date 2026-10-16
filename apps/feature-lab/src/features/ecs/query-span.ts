import { defineComponent, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'QuerySpan packed columns',
  catalog: 'QuerySpan',
  kind: 'headless',
  summary:
    'query.spans() yields contiguous typed columns plus the matching entity handles; writes go through span.mut and bump change versions.',
  expect:
    'All checks pass: span writes land on the right entities, changed() sees them once, and a span over optional data is refused with query-span-unavailable.',
  run(checks) {
    const Pos = defineComponent('FLSpanPos', { x: 'f32' });
    const Vel = defineComponent('FLSpanVel', { dx: 'f32' });
    const Opt = defineComponent('FLSpanOpt', { y: 'f32' });
    const world = new World();
    const ids = [0, 1, 2, 3].map((i) =>
      world
        .spawn({ component: Pos, data: { x: i } }, { component: Vel, data: { dx: i * 10 } })
        .unwrap(),
    );
    world.spawn({ component: Pos, data: { x: 100 } }).unwrap();
    const changed = world.query({ read: [Pos], changed: [Pos] }).unwrap();
    checks.equal('changed drains initial rows', [...changed].length, 5);
    checks.equal('changed then empty', [...changed].length, 0);
    const q = world.query({ read: [Vel], write: [Pos] }).unwrap();
    const spans = q.spans();
    checks.ok('spans ok', spans.ok);
    if (spans.ok) {
      let total = 0;
      for (const span of spans.value) {
        const pos = span.mut(Pos);
        const vel = span.get(Vel);
        checks.equal('entities length matches', span.entities.length, span.length);
        for (let i = 0; i < span.length; i += 1) pos.x[i] = (pos.x[i] ?? 0) + (vel.dx[i] ?? 0);
        total += span.length;
      }
      checks.equal('span rows', total, 4);
    }
    const e2 = ids[2];
    const read2 = e2 === undefined ? undefined : world.get(e2, Pos);
    checks.equal('entity 2 x=2+20', read2?.ok ? read2.value.x : 'missing', 22);
    checks.equal('changed sees span writes', [...changed].length, 4);
    const optional = world
      .query({ read: [Pos], optional: [Opt] })
      .unwrap()
      .spans();
    checks.equal(
      'optional data has no span',
      optional.ok ? 'ok' : optional.error.code,
      'query-span-unavailable',
    );
    const conflict = world.query({ read: [Pos], write: [Pos] });
    checks.equal(
      'read+write conflict',
      conflict.ok ? 'ok' : conflict.error.code,
      'query-descriptor-conflict',
    );
  },
});
