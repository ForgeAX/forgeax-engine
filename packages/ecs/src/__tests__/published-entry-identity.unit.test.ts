import { expect, it } from 'vitest';
import type { QuerySpan } from '../query/query';

export function publishedIdentityKernel(_spans: readonly QuerySpan[]): void {}

it('publishes resource factories that retain token identity through ordered systems', async () => {
  const root = (await import(
    new URL('../../dist/index.mjs', import.meta.url).href
  )) as typeof import('../index');
  expect(root).toHaveProperty('defineResource', expect.any(Function));
  const count = root.defineResource<number>('published-count');
  const unrelated = root.defineResource<number>('published-count');
  expect(Object.isFrozen(count)).toBe(true);
  const world = new root.World();
  world.insertResource(count, 0);
  expect(world.hasResource(unrelated)).toBe(false);
  const order = root.defineSystemSet({ name: 'published-resource-order' });
  const increment = root.defineSystem({
    name: 'published-resource-increment',
    sets: [order],
    queries: [],
    fn: (world) => world.insertResource(count, world.getResource(count) + 1),
  });
  const observed: number[] = [];
  world.addSystem(root.Update, increment).unwrap();
  world
    .addSystem(
      root.Update,
      root.defineSystem({
        name: 'published-resource-observe',
        after: [order],
        queries: [],
        fn: (world) => observed.push(world.getResource(count)),
      }),
    )
    .unwrap();
  world.update(0).unwrap();
  expect(observed).toEqual([1]);
});

it('shares resource and clock identities across the published root and shared entries', async () => {
  const root = (await import(
    new URL('../../dist/index.mjs', import.meta.url).href
  )) as typeof import('../index');
  const shared = (await import(
    new URL('../../dist/shared.mjs', import.meta.url).href
  )) as typeof import('../shared');
  expect(shared.SHARED_KERNEL_EXECUTOR_RESOURCE_KEY).toBe(root.SHARED_KERNEL_EXECUTOR_RESOURCE_KEY);
  const world = new root.World({ storage: 'shared' });
  expect(world.getResource(root.Time).elapsed).toBe(0);
  expect(world.getResource(root.FixedTime).tick).toBe(0);
  const Position = root.defineComponent('PublishedEntryIdentityPosition', { x: 'f32' });
  world.spawn({ component: Position, data: { x: 1 } }).unwrap();
  let dispatched = 0;
  world.insertResource(root.SHARED_KERNEL_EXECUTOR_RESOURCE_KEY, {
    execute(kernel, spans) {
      dispatched++;
      kernel.run(spans.map((entry) => entry.span));
      return { mode: 'shared', dispatched: spans.length, completed: spans.length, waitMs: 0 };
    },
  });
  const kernel = shared.defineSharedKernel(import.meta.url, {
    name: 'published-entry-identity',
    minimumRows: 1,
    queries: [{ write: [Position] }],
    run: publishedIdentityKernel,
  });
  world.addSystem(root.Update, kernel).unwrap();
  world.update(0).unwrap();
  expect(dispatched).toBe(1);
});
