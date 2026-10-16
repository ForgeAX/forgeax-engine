import { createWorldContext, World } from '@forgeax/engine/ecs';
import { Path, PathFollower, pathPlugin } from '@forgeax/engine/path';
import { GlobalTransform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Saved paths and world-distance following',
  catalog: 'Saved paths and world-distance following',
  kind: 'headless',
  summary:
    'Ordinary Scene path components prepare shared world-distance data; independent followers advance through the World fixed schedule.',
  expect:
    'Checks pass for two independent followers, pause, reverse and control replacement with retained distance.',
  async run(checks) {
    const world = new World();
    const context = await createWorldContext(world, [pathPlugin()]);
    try {
      const path = world.spawn({ component: Path, data: { points: [0, 0, 0, 0, 0, 10] } }).unwrap();
      const one = world.spawn({ component: PathFollower, data: { path, speed: 2 } }).unwrap();
      const two = world
        .spawn({ component: PathFollower, data: { path, distance: 5, speed: -2 } })
        .unwrap();
      for (let i = 0; i < 60; i++) world.update(1 / 60).unwrap();
      checks.near('forward world distance', world.get(one, PathFollower).unwrap().distance, 2);
      checks.near(
        'reverse independent distance',
        world.get(two, PathFollower).unwrap().distance,
        3,
      );
      checks.near(
        'propagated position',
        world.get(one, GlobalTransform).unwrap().world[14] as number,
        2,
      );
      world.set(one, PathFollower, { paused: true }).unwrap();
      world.set(path, Path, { points: [0, 0, 0, 10, 0, 0] }).unwrap();
      world.update(1 / 60).unwrap();
      checks.near('paused progress retained', world.get(one, PathFollower).unwrap().distance, 2);
      checks.near(
        'new controls replace old preparation',
        world.get(one, GlobalTransform).unwrap().world[12] as number,
        2,
      );
    } finally {
      await context.fiber.dispose();
    }
    checks.ok(
      'native detach removes following',
      !world.inspect().systems.some((s) => s.name === 'path/follow'),
    );
  },
});
