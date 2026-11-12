import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { GlobalTransform, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createSurfaceAppLifecycleApp } from './surface-standard-pipeline.runtime-fixture';

function sceneOnlyRenderer(): Renderer {
  return {
    backend: 'webgpu',
    ready: Promise.resolve(ok(undefined)),
    state: () => 'alive',
    subscribe: () => () => {},
    draw: () => {
      throw new Error('Scene publication regression must not submit GPU work');
    },
  } as unknown as Renderer;
}

describe('Surface App lifecycle Scene publication', () => {
  it('publishes players spawned after the standalone scene propagation', async () => {
    const world = new World();
    world.spawn({ component: Transform, data: { pos: [0, 0, 6] } }).unwrap();
    propagateTransforms(world).unwrap();
    const positions = [
      [2.05, 0.08, 0],
      [2.3, -0.08, 0],
    ] as const;
    const players = positions.map((pos) => ({
      entity: world.spawn({ component: Transform, data: { pos } }).unwrap(),
      position: pos,
    }));
    const app = (await createSurfaceAppLifecycleApp(sceneOnlyRenderer(), world)).unwrap();
    try {
      world.update(1 / 60).unwrap();
      for (const { entity, position } of players) {
        const actual = world.get(entity, GlobalTransform).unwrap().world;
        expect(actual[12]).toBeCloseTo(position[0], 6);
        expect(actual[13]).toBeCloseTo(position[1], 6);
        expect(actual[14]).toBe(0);
      }
    } finally {
      await app.dispose();
    }
  });

  it('publishes the camera move and restore on their World updates', async () => {
    const world = new World();
    const camera = world.spawn({ component: Transform, data: { pos: [0, 0, 6] } }).unwrap();
    propagateTransforms(world).unwrap();
    const app = (await createSurfaceAppLifecycleApp(sceneOnlyRenderer(), world)).unwrap();
    try {
      world.set(camera, Transform, { pos: [0.9, 0, 6] }).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(camera, GlobalTransform).unwrap().world[12]).toBeCloseTo(0.9, 6);
      world.set(camera, Transform, { pos: [0, 0, 6] }).unwrap();
      world.update(1 / 60).unwrap();
      expect(Array.from(world.get(camera, GlobalTransform).unwrap().world.slice(12, 15))).toEqual([
        0, 0, 6,
      ]);
    } finally {
      await app.dispose();
    }
  });
});
