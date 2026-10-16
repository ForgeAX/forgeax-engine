import { defineComponent, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Archetype SoA storage',
  catalog: 'Archetype SoA storage',
  kind: 'headless',
  summary:
    'Entities group by component set into archetypes with per-field columns; adding a component migrates the row, and no Table/Column object leaks.',
  expect:
    'All checks pass: archetype counts follow the component sets, migration keeps values, and spans expose typed columns only.',
  run(checks) {
    const P = defineComponent('FLSoaPos', { x: 'f32', y: 'f32' });
    const V = defineComponent('FLSoaVel', { dx: 'f32' });
    const world = new World();
    const onlyP = [1, 2, 3].map((x) => world.spawn({ component: P, data: { x, y: 0 } }).unwrap());
    const pv = world
      .spawn({ component: P, data: { x: 9, y: 9 } }, { component: V, data: { dx: 1 } })
      .unwrap();
    const withP = () =>
      world.inspect().archetypes.filter((a) => a.componentNames.includes('FLSoaPos'));
    checks.equal('two archetypes contain P', withP().length, 2);
    checks.equal(
      'P-only archetype holds 3',
      withP().find((a) => a.componentNames.length === 2)?.entityCount,
      3,
    );
    const first = onlyP[0];
    if (first !== undefined) {
      checks.ok(
        'addComponent migrates row',
        world.addComponent(first, { component: V, data: { dx: 5 } }).ok,
      );
      checks.near('value preserved after migration', world.get(first, P).unwrap().x, 1);
    }
    checks.equal(
      'PV archetype holds 2',
      withP().find((a) => a.componentNames.includes('FLSoaVel'))?.entityCount,
      2,
    );
    const spans = world
      .query({ read: [P] })
      .unwrap()
      .spans();
    checks.ok('spans available', spans.ok);
    if (spans.ok) {
      let rows = 0;
      let columnsAreTyped = true;
      for (const span of spans.value) {
        rows += span.length;
        const col = span.get(P);
        columnsAreTyped &&= col.x instanceof Float32Array && col.y instanceof Float32Array;
      }
      checks.equal('span rows cover all P entities', rows, 4);
      checks.ok('columns are Float32Array per field', columnsAreTyped);
    }
    checks.ok('pv entity still valid', world.get(pv, V).ok);
    const info = world.inspect();
    checks.ok(
      'inspection is frozen POD',
      Object.isFrozen(info) && Object.isFrozen(info.archetypes),
    );
    checks.ok(
      'tables are POD summaries',
      info.tables.every(
        (t) => typeof t.id === 'number' && typeof t.capacity === 'number' && !('storage' in t),
      ),
    );
  },
});
