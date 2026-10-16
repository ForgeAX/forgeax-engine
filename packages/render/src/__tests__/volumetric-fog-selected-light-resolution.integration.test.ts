import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { DirectionalLight, SpotLight } from '../index';
import { resolveSelectedVolumetricLight } from '../volume/capability';

describe('selected volumetric light resolution', () => {
  it('selects a real DirectionalLight or SpotLight entity', () => {
    const world = new World();
    const directional = world
      .spawn({ component: DirectionalLight, data: { direction: [0, -1, 0] } })
      .unwrap();
    const spot = world
      .spawn(
        { component: Transform, data: { pos: [0, 2, 0] } },
        { component: SpotLight, data: { direction: [0, -1, 0] } },
      )
      .unwrap();

    expect(resolveSelectedVolumetricLight(world, directional)).toMatchObject({
      status: 'available',
      entity: directional,
      kind: 'directional',
    });
    expect(resolveSelectedVolumetricLight(world, spot)).toMatchObject({
      status: 'available',
      entity: spot,
      kind: 'spot',
    });
  });

  it('returns closed reasons for missing, wrong-component, and ambiguous entities', () => {
    const world = new World();
    const ordinary = world.spawn().unwrap();
    const both = world
      .spawn(
        { component: Transform, data: { pos: [0, 2, 0] } },
        { component: DirectionalLight, data: { direction: [0, -1, 0] } },
        { component: SpotLight, data: { direction: [0, -1, 0] } },
      )
      .unwrap();
    const otherWorld = new World();
    otherWorld.spawn();
    otherWorld.spawn();
    otherWorld.spawn();
    const foreign = otherWorld
      .spawn({ component: DirectionalLight, data: { direction: [0, -1, 0] } })
      .unwrap();

    expect(resolveSelectedVolumetricLight(world, ordinary)).toMatchObject({
      status: 'unresolved',
      reason: 'wrong-component',
    });
    expect(resolveSelectedVolumetricLight(world, both)).toMatchObject({
      status: 'unresolved',
      reason: 'ambiguous',
    });
    expect(resolveSelectedVolumetricLight(world, foreign)).toMatchObject({
      status: 'unresolved',
      reason: 'missing-entity',
    });
  });
});
