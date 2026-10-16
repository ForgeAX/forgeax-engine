// Shared scene for Bevy `sprite_flipping` reproduction.
// The asymmetric arrow makes the two UV orientations visually falsifiable.

import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

export const SPRITE_SIZE = 32;

export function makeSpritePixels(): Uint8Array {
  const data = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const off = (y * SPRITE_SIZE + x) * 4;
      const left = x < 16;
      const top = y < 16;
      const marker = (x < 10 || x >= 22) && (y < 10 || y >= 22);
      const markerColor: readonly [number, number, number] = top
        ? left ? [230, 40, 40] : [40, 210, 70]
        : left ? [40, 90, 235] : [240, 200, 40];
      const inside = x >= 4 && x <= 27 && y >= 5 && y <= 26;
      const arrow = inside && ((x >= 8 && y <= 15) || (x >= 4 && y >= 18 && y <= 24));
      const color: readonly [number, number, number] = marker ? markerColor : arrow ? [245, 164, 48] : [16, 24, 42];
      data[off] = color[0];
      data[off + 1] = color[1];
      data[off + 2] = color[2];
      data[off + 3] = marker || inside ? 255 : 0;
    }
  }
  return data;
}

function spriteMaterial(texture: number, flipX = 0, flipY = 0): MaterialAsset {
  const region: readonly [number, number, number, number] = [
    flipX === 1 ? 1 : 0,
    flipY === 1 ? 1 : 0,
    flipX === 1 ? -1 : 1,
    flipY === 1 ? -1 : 1,
  ];
  return {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } },
    ],
    parameters: [
      { name: 'colorTint', type: 'vec4' },
      { name: 'region', type: 'vec4', optional: true },
      { name: 'pivotAndSize', type: 'vec4' },
      { name: 'slicesAndMode', type: 'vec4', optional: true },
      { name: 'baseColorTexture', type: 'texture' },
    ],
    values: { colorTint: [1, 1, 1, 1], baseColorTexture: texture, region, pivotAndSize: [0.5, 0.5, 1, 1] },
  };
}

/** Build the scene after the caller uploads the TextureAsset to the GPU. */
export function buildSpriteFlippingWorld(world: World, texId: number): void {
  const normalMat = world.allocSharedRef('MaterialAsset', spriteMaterial(texId));
  const flipXMat = world.allocSharedRef('MaterialAsset', spriteMaterial(texId, 1));
  const flipYMat = world.allocSharedRef('MaterialAsset', spriteMaterial(texId, 0, 1));

  for (const [x, material] of [[-2.6, normalMat], [0, flipXMat], [2.6, flipYMat]] as const) {
    world.spawn(
      { component: Transform, data: { pos: [x, 0, 0], quat: [0, 0, 0, 1], scale: [2, 2, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [material] } },
    );
  }

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -5, right: 5, bottom: -3, top: 3, near: 0.1, far: 100 }) },
  );
}
