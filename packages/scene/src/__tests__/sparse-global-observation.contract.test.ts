import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { expect, it, vi } from 'vitest';
import { GlobalTransform, propagateTransforms, Transform } from '../index';

const INTERNAL: unique symbol = Symbol.for(
  'forgeax.ecs.worldInternal',
) as unknown as typeof INTERNAL;

it('observes sparse derived transforms without walking the complete entity table', () => {
  const world = new World();
  const movers: EntityHandle[] = [];
  for (let index = 0; index < 50_000; index++) {
    const entity = world.spawn({ component: Transform, data: { pos: [index, 0, 0] } }).unwrap();
    if (index < 100) movers.push(entity);
  }
  propagateTransforms(world).unwrap();
  for (const entity of movers) world.set(entity, Transform, { pos: [7, 0, 0] }).unwrap();
  const internal = (world as unknown as { [INTERNAL]: { getGraph(): unknown } })[INTERNAL];
  const graphReads = vi.spyOn(internal, 'getGraph');
  try {
    propagateTransforms(world).unwrap();
    // A row walk reads the graph per entity. Sparse observation must stay
    // proportional to changed ranges and table blocks, not the 50k population.
    expect(graphReads.mock.calls.length).toBeLessThan(5_000);
    for (const entity of movers)
      expect(world.get(entity, GlobalTransform).unwrap().world[12]).toBe(7);
  } finally {
    graphReads.mockRestore();
  }
});
