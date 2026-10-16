import { Layer } from '@forgeax/engine/render';
import { TransparentSort } from '@forgeax/engine/render/authoring';
import { defineFeature } from '../../lab/feature';
import {
  discTexture,
  spawnOrthoCamera,
  spawnSprite,
  spriteMaterial,
  spriteMaterialAsset,
} from './_shared/sprite';

export default defineFeature({
  title: 'Sprite',
  catalog: 'Sprite',
  kind: 'visual',
  summary:
    'Three overlapping tinted disc sprites render through the ordinary Renderer with a forgeax::sprite MaterialAsset, HANDLE_QUAD and Layer; TransparentSort layerZ orders them by Layer.',
  expect:
    'ON: blue is on top of green, green on top of red. OFF: the Layer values are reversed so red is drawn on top of green and blue; the overlap regions change color.',
  setup({ world, canvas }) {
    const sort = TransparentSort.configure(world, { mode: TransparentSort.layerZ, yzAlpha: 1 });
    if (!sort.ok) throw new Error(`TransparentSort.configure: ${sort.error.code}`);
    spawnOrthoCamera(world, canvas);
    const disc = discTexture(world);
    const tints = [
      [1, 0.15, 0.15, 1],
      [0.15, 1, 0.2, 1],
      [0.2, 0.35, 1, 1],
    ] as const;
    const sprites = tints.map((tint, i) =>
      spawnSprite(
        world,
        spriteMaterial(world, spriteMaterialAsset(disc, tint)),
        [(i - 1) * 1.1, (i - 1) * 0.35, 0],
        2.4,
        i * 10,
      ),
    );
    return {
      toggle(on) {
        sprites.forEach((entity, i) => {
          world.set(entity, Layer, { value: on ? i * 10 : (2 - i) * 10 });
        });
      },
    };
  },
});
