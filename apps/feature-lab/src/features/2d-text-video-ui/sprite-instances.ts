import { HANDLE_QUAD } from '@forgeax/engine/assets-runtime';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { SpriteInstances } from '@forgeax/engine/render/authoring';
import { Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import {
  quadrantTexture,
  spawnOrthoCamera,
  spriteMaterial,
  spriteMaterialAsset,
  VIEW_HALF_WIDTH,
  viewHalfHeight,
} from './_shared/sprite';

const COLS = 24;
const ROWS = 12;

function grid(
  rows: number,
  halfHeight: number,
): { transforms: Float32Array; regions: Float32Array } {
  const count = COLS * rows;
  const transforms = new Float32Array(count * 16);
  const regions = new Float32Array(count * 4);
  const stepX = (VIEW_HALF_WIDTH * 2) / COLS;
  const stepY = (halfHeight * 2) / ROWS;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      const t = i * 16;
      transforms[t] = stepX * 0.8;
      transforms[t + 5] = stepY * 0.8;
      transforms[t + 10] = 1;
      transforms[t + 12] = -VIEW_HALF_WIDTH + stepX * (c + 0.5);
      transforms[t + 13] = halfHeight - stepY * (r + 0.5);
      transforms[t + 15] = 1;
      const q = (r + c) % 4;
      regions.set([(q % 2) * 0.5, Math.floor(q / 2) * 0.5, 0.5, 0.5], i * 4);
    }
  }
  return { transforms, regions };
}

export default defineFeature({
  title: 'Sprite Instances',
  catalog: 'Sprite Instances',
  kind: 'visual',
  summary: `One entity carries SpriteInstances with ${COLS * ROWS} packed mat4 transforms and per-instance atlas regions; the Renderer draws them as one instanced sprite draw with a forgeax::sprite material.`,
  expect:
    'ON: the whole canvas is tiled by a 24x12 diagonal pattern of red/green/blue/yellow squares. OFF: the component is rewritten with only the top 2 rows, so the rest of the canvas is empty.',
  setup({ world, canvas }) {
    spawnOrthoCamera(world, canvas);
    const halfHeight = viewHalfHeight(canvas);
    const mat = spriteMaterial(world, spriteMaterialAsset(quadrantTexture(world), [1, 1, 1, 1]));
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } as never },
        { component: MeshRenderer, data: { materials: [mat] } as never },
        { component: SpriteInstances, data: grid(ROWS, halfHeight) },
      )
      .unwrap();
    return {
      toggle(on) {
        world.set(entity, SpriteInstances, grid(on ? ROWS : 2, halfHeight));
      },
    };
  },
});
