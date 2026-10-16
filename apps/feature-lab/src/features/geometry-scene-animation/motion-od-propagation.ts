import { type EntityHandle, type Query, World } from '@forgeax/engine/ecs';
import { ChildOf, GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';

const POPULATION = 20_000;

function drain(query: Query): number[] {
  const entities: number[] = [];
  for (const span of query.spans().unwrap()) entities.push(...span.entities);
  return entities.sort((a, b) => a - b);
}

export default defineFeature({
  title: 'O(D) transform propagation',
  catalog: 'O(D) moving-object propagation',
  kind: 'headless',
  summary:
    'propagateTransforms recomposes only dirty flat rows and the highest dirty hierarchy roots, and publishes GlobalTransform change evidence for exactly the recomputed subtree, so upstream cost follows the D moved objects rather than the population.',
  expect:
    'All checks pass over a 20k-entity world: a no-op pass publishes nothing, moving one flat entity publishes one row, moving a child publishes child+grandchild only, and an unrelated spawn publishes just the spawned row.',
  run(checks) {
    const world = new World();
    const flats: EntityHandle[] = [];
    for (let i = 0; i < POPULATION; i++)
      flats.push(
        world.spawn({ component: Transform, data: { pos: [i, 0, 0] } }).unwrap() as EntityHandle,
      );
    const root = world
      .spawn({ component: Transform, data: { pos: [1, 0, 0] } })
      .unwrap() as EntityHandle;
    const child = world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap() as EntityHandle;
    const grandchild = world
      .spawn(
        { component: Transform, data: { pos: [3, 0, 0] } },
        { component: ChildOf, data: { parent: child } },
      )
      .unwrap() as EntityHandle;

    checks.ok('initial propagation', propagateTransforms(world).ok);
    const changes = world.query({ changed: [GlobalTransform] }).unwrap();
    checks.equal(
      'initial publication covers the population',
      drain(changes).length,
      POPULATION + 3,
    );

    propagateTransforms(world).unwrap();
    checks.equal('no-op pass publishes nothing', drain(changes), []);

    const mover = flats[1234] as EntityHandle;
    world.set(mover, Transform, { pos: [-5, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    checks.equal('one moved flat row', drain(changes), [mover]);
    checks.near(
      'moved row world x',
      world.get(mover, GlobalTransform).unwrap().world[12] as number,
      -5,
    );

    world.set(child, Transform, { pos: [8, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    checks.equal(
      'moved child publishes its subtree only',
      drain(changes),
      [child, grandchild].sort((a, b) => a - b),
    );
    checks.near(
      'grandchild world x',
      world.get(grandchild, GlobalTransform).unwrap().world[12] as number,
      12,
    );

    const spawned = world
      .spawn({ component: Transform, data: { pos: [7, 0, 0] } })
      .unwrap() as EntityHandle;
    propagateTransforms(world).unwrap();
    checks.equal('unrelated spawn publishes one row', drain(changes), [spawned]);
    checks.near(
      'spawned world x',
      world.get(spawned, GlobalTransform).unwrap().world[12] as number,
      7,
    );
  },
});
