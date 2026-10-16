import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { PointLight, SpotLight } from '../index';
import { resolveSelectedVolumetricLight } from '../volume/capability';

describe('VolumetricFog Point+Spot selection', () => {
  it('resolves one PointLight and one SpotLight as one accepted pair', () => {
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

    expect(resolveSelectedVolumetricLight(world, point)).toMatchObject({
      status: 'available',
      kind: 'point',
      entity: point,
    });
    expect(resolveSelectedVolumetricLight(world, spot)).toMatchObject({
      status: 'available',
      kind: 'spot',
      entity: spot,
    });
  });

  it('does not accept a foreign-world or three-light combination', () => {
    const world = new World();
    const foreignWorld = new World();
    const foreign = foreignWorld
      .spawn(
        { component: Transform, data: { pos: [0, 1, 0] } },
        { component: PointLight, data: {} },
      )
      .unwrap();
    expect(resolveSelectedVolumetricLight(world, foreign)).toMatchObject({
      status: 'unresolved',
      reason: 'missing-entity',
    });
  });
});
