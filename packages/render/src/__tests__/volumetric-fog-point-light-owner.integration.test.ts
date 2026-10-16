import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { PointLight, SpotLight } from '../index';
import { resolveVolumetricFogLightPair } from '../volume/capability';

describe('volumetric fog punctual owner selection', () => {
  it('keeps Point and Spot identities distinct in one accepted pair', () => {
    const world = new World();
    const point = world
      .spawn(
        { component: Transform, data: { pos: [0, 1.4, 0] } },
        { component: PointLight, data: {} },
      )
      .unwrap();
    const spot = world
      .spawn(
        { component: Transform, data: { pos: [2.5, 5, 2.5] } },
        { component: SpotLight, data: { direction: [-2.5, -5, -2.5] } },
      )
      .unwrap();
    expect(resolveVolumetricFogLightPair(world, point, spot)).toEqual({
      status: 'available',
      mode: 'point-spot',
      point,
      spot,
    });
  });

  it('rejects same entity and foreign-world handles without synthesizing lights', () => {
    const world = new World();
    const other = new World();
    const point = other
      .spawn(
        { component: Transform, data: { pos: [0, 1, 0] } },
        { component: PointLight, data: {} },
      )
      .unwrap();
    expect(resolveVolumetricFogLightPair(world, point, point)).toMatchObject({
      status: 'unresolved',
      reason: 'missing-entity',
    });
  });
});
