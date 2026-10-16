import { Time, Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

function code(body: () => unknown): string {
  try {
    body();
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'thrown';
  }
}

export default defineFeature({
  title: 'ECS Resource',
  catalog: 'ECS Resource',
  kind: 'headless',
  summary:
    'World stores non-owning resource values by string or token key; it never disposes an external payload.',
  expect:
    'All checks pass: insert/get/has/remove work, systems see the same object, removal never calls dispose, and missing/protected keys give structured codes.',
  run(checks) {
    const world = new World();
    let disposed = 0;
    const external = {
      hits: 0,
      dispose: () => {
        disposed += 1;
      },
    };
    world.insertResource('FLResExternal', external);
    checks.ok('hasResource', world.hasResource('FLResExternal'));
    checks.ok('same object identity', world.getResource('FLResExternal') === external);
    world.addSystem(Update, {
      name: 'fl-res-hit',
      queries: [],
      fn: (world) => {
        world.getResource<typeof external>('FLResExternal').hits += 1;
      },
    });
    world.update(1 / 60);
    world.update(1 / 60);
    checks.equal('system mutates the stored object', external.hits, 2);
    world.insertResource({ name: 'FLResToken' }, 42);
    checks.equal('token key', world.getResource<number>({ name: 'FLResToken' }), 42);
    world.insertResource('FLResToken', 43);
    checks.equal('insert overwrites', world.getResource<number>('FLResToken'), 43);
    world.removeResource('FLResExternal');
    checks.ok('removed', !world.hasResource('FLResExternal'));
    checks.equal('World did not dispose payload', disposed, 0);
    checks.equal(
      'missing resource',
      code(() => world.getResource('FLResMissing')),
      'resource-not-found',
    );
    checks.equal(
      'Time is protected',
      code(() => world.removeResource(Time)),
      'resource-protected',
    );
    checks.ok('inspect lists keys', world.inspect().resourceKeys.includes('FLResToken'));
  },
});
