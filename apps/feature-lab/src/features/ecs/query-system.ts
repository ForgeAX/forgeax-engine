import { defineComponent, defineSystem, Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Components, queries and Update systems',
  catalog: 'Query row',
  kind: 'headless',
  summary:
    'defineComponent declares a typed schema, world.spawn creates rows, and an Update system mutates them through row.mut.',
  expect:
    'All checks pass: three spawned entities are queried and each Position.x advances by 1 per world.update.',
  run(checks) {
    const Position = defineComponent('FeatureLabPosition', { x: { type: 'f32', default: 0 } });
    const Move = defineSystem({
      name: 'feature-lab-move',
      queries: [{ write: [Position] }],
      fn: (_world, [rows]) => {
        for (const row of rows) row.mut(Position).x += 1;
      },
    });
    const world = new World();
    for (const x of [0, 10, 20])
      checks.ok(`spawn x=${x}`, world.spawn({ component: Position, data: { x } }).ok);
    checks.ok('addSystem(Update)', world.addSystem(Update, Move).ok);
    checks.ok('update #1', world.update(1 / 60).ok);
    checks.ok('update #2', world.update(1 / 60).ok);
    const xs: number[] = [];
    for (const row of world.query({ read: [Position] }).unwrap()) xs.push(row.get(Position).x);
    checks.equal(
      'positions after two updates',
      xs.sort((a, b) => a - b),
      [2, 12, 22],
    );
  },
});
