import { describe, expect, it } from 'vitest';
import { parseScenePayload } from '../scene-payload';

describe('component-qualified scene density wire fields', () => {
  const refs = ['texture-guid', 'material-guid'];

  it('preserves Collider numeric density alongside a volume texture reference', () => {
    expect(
      parseScenePayload(
        {
          entities: {
            'ordinary-control': { components: { Collider: { density: 1 } } },
            smoke: { components: { VolumetricFog: { density: 0 } } },
          },
        },
        refs,
      ),
    ).toMatchObject({
      entities: {
        'ordinary-control': { components: { Collider: { density: 1 } } },
        smoke: { components: { VolumetricFog: { density: 'texture-guid' } } },
      },
    });
  });

  it('does not reinterpret scalar density by reference bounds or its field name', () => {
    for (const density of [0, 1, 3, 0.5, null]) {
      expect(
        parseScenePayload(
          { entities: { body: { components: { Collider: { density }, Custom: { density } } } } },
          refs,
        ),
      ).toMatchObject({
        entities: { body: { components: { Collider: { density }, Custom: { density } } } },
      });
    }
  });

  it('retains volume texture null and out-of-bounds reference behavior', () => {
    expect(
      parseScenePayload(
        { entities: { smoke: { components: { VolumetricFog: { density: null } } } } },
        refs,
      ),
    ).toMatchObject({ entities: { smoke: { components: { VolumetricFog: { density: 0 } } } } });
    expect(
      parseScenePayload(
        { entities: { smoke: { components: { VolumetricFog: { density: 3 } } } } },
        refs,
      ),
    ).toEqual({
      entityKey: 'smoke',
      component: 'VolumetricFog',
      field: 'density',
      index: 3,
      refsLength: 2,
    });
  });
});
