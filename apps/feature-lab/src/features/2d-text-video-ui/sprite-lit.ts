import { DirectionalLight, PointLight, SpotLight, TONEMAP_NONE } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import {
  spawnOrthoCamera,
  spawnSprite,
  spriteMaterial,
  spriteMaterialAsset,
  texture,
  textureAsset,
} from './_shared/sprite';

export default defineFeature({
  title: 'Sprite Lit',
  catalog: 'Sprite Lit',
  kind: 'visual',
  summary:
    'A row of white checker sprites uses the forgeax::sprite-lit program and is lit by a dim directional light, a magenta PointLight on the left and a cyan SpotLight on the right.',
  expect:
    'ON: the left sprites glow magenta and the right sprites cyan around the light positions over a dim warm base. OFF: point and spot intensity drop to 0, so only the dim directional base remains.',
  setup({ world, canvas }) {
    spawnOrthoCamera(world, canvas, { tonemap: TONEMAP_NONE });
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, -0.3], color: [1, 0.95, 0.85], intensity: 0.35 },
      })
      .unwrap();
    const point = world
      .spawn(
        { component: Transform, data: { pos: [-2, 0, 1.2] } },
        { component: PointLight, data: { color: [1, 0.3, 1], intensity: 6, range: 4 } },
      )
      .unwrap();
    const spot = world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 2] } },
        {
          component: SpotLight,
          data: {
            direction: [0, 0, -1],
            color: [0.3, 1, 1],
            intensity: 8,
            range: 6,
            innerConeDeg: 20,
            outerConeDeg: 40,
          },
        },
      )
      .unwrap();
    const checker = texture(
      world,
      textureAsset(16, 16, (x, y) =>
        (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? [1, 1, 1, 1] : [0.7, 0.7, 0.7, 1],
      ),
    );
    const mat = spriteMaterial(
      world,
      spriteMaterialAsset(checker, [1, 1, 1, 1], { module: 'forgeax::sprite-lit' }),
    );
    for (let i = 0; i < 5; i++) spawnSprite(world, mat, [(i - 2) * 1.35, 0, 0], 1.25);
    return {
      toggle(on) {
        world.set(point, PointLight, { intensity: on ? 6 : 0 });
        world.set(spot, SpotLight, { intensity: on ? 8 : 0 });
      },
    };
  },
});
