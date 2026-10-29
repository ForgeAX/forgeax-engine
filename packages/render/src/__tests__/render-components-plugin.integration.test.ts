import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type Component, createWorldContext, World } from '@forgeax/engine-ecs';
import { scenePlugin, worldDespawnScene } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Skylight } from '../components/skylight';
import * as render from '../index';
import { renderComponentsPlugin } from '../plugin';

describe('render component vocabulary', () => {
  it('leases every publicly exported render component for Scene loading', async () => {
    const components = Object.values<unknown>(render).filter(
      (value): value is Component =>
        typeof value === 'object' &&
        value !== null &&
        'name' in value &&
        'fields' in value &&
        'storage' in value,
    );
    expect(components.length).toBeGreaterThan(0);
    const world = new World();
    const context = await createWorldContext(world, [renderComponentsPlugin()]);
    try {
      expect(
        components
          .filter((component) => world.components.resolve(component.name) !== component)
          .map((component) => component.name),
      ).toEqual([]);
    } finally {
      await context.fiber.dispose();
    }
    for (const component of components) {
      expect(world.components.resolve(component.name), component.name).toBeUndefined();
    }
  });

  it('admits and instantiates a JSON Scene containing Skylight before any runtime spawn', async () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const context = await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
    try {
      const source: SceneAsset = JSON.parse(
        JSON.stringify({
          kind: 'scene',
          entities: {
            sky: { components: { Skylight: { color: [0.125, 0.25, 0.5], intensity: 0.7 } } },
          },
        }),
      );
      const handle = assets.create(source).unwrap();
      try {
        const root = assets.instantiate(handle, world).unwrap();
        try {
          const sky = [...world.iterDescendants(root)].find((entity) =>
            world.hasComponent(entity, Skylight),
          );
          expect(sky).toBeDefined();
          if (sky === undefined) throw new Error('Scene did not instantiate its Skylight');
          const value = world.get(sky, Skylight).unwrap();
          expect([...value.color]).toEqual([0.125, 0.25, 0.5]);
          expect(value.intensity).toBeCloseTo(0.7);
        } finally {
          worldDespawnScene(world, root).unwrap();
        }
      } finally {
        assets.release(handle).unwrap();
      }
    } finally {
      await context.fiber.dispose();
    }
  });
});
