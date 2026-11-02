import { Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'ECS numeric memory services',
  catalog: 'ECS numeric memory services',
  kind: 'headless',
  summary:
    'World supplies automatic synchronous frame scratch and explicit owned numeric buffers with reader-aware retirement.',
  expect:
    'Warm frame backing is reused, old grants reject, leased data survives retirement, and idle backing can be trimmed.',
  run(checks) {
    const world = new World();
    world
      .addSystem(Update, {
        name: 'lab-memory',
        commands: 'none',
        queries: [],
        fn: (world) => {
          world.frameArena.alloc(Float32Array, 1024).unwrap().fill(3);
        },
      })
      .unwrap();
    world.update().unwrap();
    const allocations = world.memoryStats().arena.backingAllocations;
    world.update().unwrap();
    checks.equal(
      'warm arena backing reused',
      world.memoryStats().arena.backingAllocations,
      allocations,
    );
    checks.ok('scratch closes automatically', !world.frameArena.isActive);
    const handle = world.buffers.alloc(Uint32Array, 4).unwrap();
    world.buffers.view(handle).unwrap().fill(17);
    const reader = world.buffers.borrow(handle).unwrap();
    world.buffers.release(handle).unwrap();
    checks.ok('retired owner grant rejects', !world.buffers.view(handle).ok);
    checks.equal('active reader still sees its data', reader.view[0], 17);
    checks.equal('pending retirement visible', world.memoryStats().readers.pendingRetirements, 1);
    reader.release().unwrap();
    checks.ok('duplicate reader return rejects', !reader.release().ok);
    world.trimMemory().unwrap();
    checks.equal('idle pool backing released', world.memoryStats().buffers.committedBytes, 0);
    checks.equal('idle arena backing released', world.memoryStats().arena.committedBytes, 0);
  },
});
