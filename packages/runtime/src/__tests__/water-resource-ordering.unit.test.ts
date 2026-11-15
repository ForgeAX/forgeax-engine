import { createWorldContext, defineResource, World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { scenePlugin } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { WATER_BUOYANCY_RESOURCE } from '../water-buoyancy.js';
import { WATER_VISUAL_CONTACTS_RESOURCE } from '../water-contact-probes.js';
import {
  WATER_SCENE_STATUS_RESOURCE,
  WATER_SYSTEM_RESOURCE,
  waterScenePlugin,
} from '../water-scene-plugin.js';
import { testAssets } from './helpers/runtime-assets.js';

describe('Water resource and schedule identity', () => {
  it('installs, runs and releases Water through tokens without taking same-named resources', async () => {
    const world = new World();
    const assets = testAssets(world);
    const namesake = defineResource<string>('WaterSystem');
    world.insertResource(namesake, 'independent owner');
    const provideAssets: Plugin = {
      name: 'test-water-assets',
      provide: 'assets',
      apply(ctx) {
        ctx.provide('assets', assets);
      },
    };
    const context = await createWorldContext(world, [
      provideAssets,
      scenePlugin(),
      waterScenePlugin(),
    ]);
    try {
      expect(world.getResource(WATER_SYSTEM_RESOURCE)).not.toBe('independent owner');
      world.update(1 / 60).unwrap();
      expect(world.getResource(WATER_BUOYANCY_RESOURCE).steps).toEqual([]);
      expect(world.getResource(WATER_VISUAL_CONTACTS_RESOURCE).contacts).toEqual([]);
      expect(world.getResource(WATER_SCENE_STATUS_RESOURCE).waterCollisionFailures).toEqual([]);
    } finally {
      await context.fiber.dispose();
      assets.dispose();
    }
    for (const resource of [
      WATER_SYSTEM_RESOURCE,
      WATER_BUOYANCY_RESOURCE,
      WATER_VISUAL_CONTACTS_RESOURCE,
      WATER_SCENE_STATUS_RESOURCE,
    ])
      expect(world.hasResource(resource)).toBe(false);
    expect(world.getResource(namesake)).toBe('independent owner');
  });
});
