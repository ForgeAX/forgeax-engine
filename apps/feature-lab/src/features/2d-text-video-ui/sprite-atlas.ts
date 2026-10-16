import { SpriteRegionOverride } from '@forgeax/engine/render/authoring';
import { defineFeature } from '../../lab/feature';
import {
  quadrantTexture,
  spawnOrthoCamera,
  spawnSprite,
  spriteMaterial,
  spriteMaterialAsset,
} from './_shared/sprite';

const RED = [0, 0, 0.5, 0.5] as const;
const YELLOW = [0.5, 0.5, 0.5, 0.5] as const;

export default defineFeature({
  title: 'Sprite Atlas',
  catalog: 'Sprite Atlas',
  kind: 'visual',
  summary:
    'One 2x2 atlas texture (red, green, blue, yellow quadrants) feeds several sprites; each picks a region with SpriteRegionOverride, the same component SpriteAnimation writes per frame. The atlas CLI half of this row runs in node-features (sprite-atlas-cli).',
  expect:
    'ON: the left sprite shows the full atlas, the three right sprites show only red, green and blue. OFF: every region override switches to the yellow quadrant, so the three right sprites turn yellow.',
  setup({ world, canvas }) {
    spawnOrthoCamera(world, canvas);
    const mat = spriteMaterial(world, spriteMaterialAsset(quadrantTexture(world), [1, 1, 1, 1]));
    spawnSprite(world, mat, [-2.4, 0, 0], 2.4);
    const regions = [RED, [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5]] as const;
    const cells = regions.map((region, i) =>
      spawnSprite(world, mat, [-0.3 + i * 1.7, 0, 0], 1.5, 0, {
        component: SpriteRegionOverride,
        data: { region: new Float32Array(region) },
      }),
    );
    return {
      toggle(on) {
        cells.forEach((entity, i) => {
          world.set(entity, SpriteRegionOverride, {
            region: new Float32Array(on ? (regions[i] ?? RED) : YELLOW),
          } as never);
        });
      },
    };
  },
});
