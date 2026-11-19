import { defineResource, defineSystem, Time, Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

const resource3 = defineResource<unknown>('FLResMissing');

const resource2 = defineResource<number>('FLResToken');

const resource1 = defineResource<{ hits: number; dispose: () => void }>('FLResExternal');

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
    'World stores non-owning resource values by typed resource identity; it never disposes an external payload.',
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
    world.insertResource(resource1, external);
    checks.ok('hasResource', world.hasResource(resource1));
    checks.ok('same object identity', world.getResource(resource1) === external);
    const systemToken1 = defineSystem({
      name: 'fl-res-hit',
      queries: [],
      fn: (world) => {
        world.getResource(resource1).hits += 1;
      },
    });
    world.addSystem(Update, systemToken1);
    world.update(1 / 60);
    world.update(1 / 60);
    checks.equal('system mutates the stored object', external.hits, 2);
    world.insertResource(resource2, 42);
    checks.equal('token key', world.getResource(resource2), 42);
    world.insertResource(resource2, 43);
    checks.equal('insert overwrites', world.getResource(resource2), 43);
    world.removeResource(resource1);
    checks.ok('removed', !world.hasResource(resource1));
    checks.equal('World did not dispose payload', disposed, 0);
    checks.equal(
      'missing resource',
      code(() => world.getResource(resource3)),
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
