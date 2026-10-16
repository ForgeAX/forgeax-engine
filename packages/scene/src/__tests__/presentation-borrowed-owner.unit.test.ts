import { createWorldContext, FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { expect, it, vi } from 'vitest';
import {
  ChildOf,
  Children,
  GlobalTransform,
  readPresentationWorldMatrix,
  scenePlugin,
  Transform,
  TransformInterpolation,
} from '../index';

it('samples the current moving subtree without materializing full component snapshots', async () => {
  const world = new World(),
    context = await createWorldContext(world, [scenePlugin()]);
  const root = world
    .spawn({ component: Transform, data: {} }, { component: TransformInterpolation, data: {} })
    .unwrap();
  const child = world
    .spawn(
      { component: Transform, data: { pos: [3, 0, 0] } },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  const other = world.spawn({ component: Transform, data: { pos: [100, 0, 0] } }).unwrap();
  world
    .addSystem(FixedUpdate, {
      name: 'move-borrowed-owner',
      queries: [],
      fn: () => {
        world.set(root, Transform, { pos: [world.getResource(FixedTime).tick * 2, 0, 0] }).unwrap();
      },
    })
    .unwrap();
  try {
    const snapshots = vi.spyOn(world, 'get');
    try {
      const fixed = world.getResource(FixedTime);
      world.update(fixed.delta * 1.5).unwrap();
      expect(readPresentationWorldMatrix(world, root)?.[12]).toBeCloseTo(1);
      expect(readPresentationWorldMatrix(world, child)?.[12]).toBeCloseTo(4);
      expect(
        snapshots.mock.calls.filter(
          ([, component]) => component === Transform || component === Children,
        ),
      ).toHaveLength(0);
    } finally {
      snapshots.mockRestore();
    }
    expect(world.get(root, GlobalTransform).unwrap().world[12]).toBeCloseTo(2);
    const children = world.get(root, Children).unwrap();
    children.entities[0] = other;
    world.set(child, Transform, { pos: [4, 0, 0] }).unwrap();
    world.update(world.getResource(FixedTime).delta / 4).unwrap();
    expect(readPresentationWorldMatrix(world, child)?.[12]).toBeCloseTo(5.5);
    world.addComponent(child, { component: ChildOf, data: { parent: other } }).unwrap();
    world.update(world.getResource(FixedTime).delta / 8).unwrap();
    expect(readPresentationWorldMatrix(world, child)?.[12]).toBeCloseTo(104);
    expect(Array.from(world.get(root, Children).unwrap().entities)).not.toContain(child);
  } finally {
    await context.fiber.dispose();
  }
});
