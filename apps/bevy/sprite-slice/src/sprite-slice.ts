import { HANDLE_NINESLICE_QUAD } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

export const TEXTURE_SIZE = 48;
export const STRETCH_SLICES = [0.25, 0.25, 0.25, 0.25] as const;
export const TILE_SLICES = [0.3, 0.3, 0.3, -0.3] as const;

export function makeSlicePixels(): Uint8Array {
  const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) for (let x = 0; x < TEXTURE_SIZE; x += 1) {
    const border = x < 12 || x >= TEXTURE_SIZE - 12 || y < 12 || y >= TEXTURE_SIZE - 12;
    const checker = ((x >> 3) + (y >> 3)) % 2 === 0;
    const o = (y * TEXTURE_SIZE + x) * 4;
    pixels[o] = border ? 245 : checker ? 60 : 35;
    pixels[o + 1] = border ? 180 : checker ? 130 : 75;
    pixels[o + 2] = border ? 60 : checker ? 220 : 160;
    pixels[o + 3] = 255;
  }
  return pixels;
}

function material(texture: number, slicesAndMode: readonly [number, number, number, number]): MaterialAsset {
  return {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } }],
    parameters: [
      { name: 'colorTint', type: 'vec4' },
      { name: 'region', type: 'vec4', optional: true },
      { name: 'pivotAndSize', type: 'vec4' },
      { name: 'slicesAndMode', type: 'vec4', optional: true },
      { name: 'baseColorTexture', type: 'texture' },
    ],
    values: { colorTint: [1, 1, 1, 1], baseColorTexture: texture, pivotAndSize: [0.5, 0.5, 1, 1], slicesAndMode },
  };
}

export function buildSpriteSliceWorld(world: World, texture: number): void {
  const panels = [
    { x: -2.9, y: 0.7, scale: [1.5, 2.5] as [number, number], slices: STRETCH_SLICES },
    { x: 0, y: 0.7, scale: [2.4, 2.5] as [number, number], slices: STRETCH_SLICES },
    { x: 2.9, y: 0.7, scale: [1.5, 2.5] as [number, number], slices: TILE_SLICES },
    { x: -1.5, y: -1.7, scale: [3.2, 1.5] as [number, number], slices: TILE_SLICES },
    { x: 1.8, y: -1.7, scale: [1.7, 1.5] as [number, number], slices: STRETCH_SLICES },
  ];
  for (const panel of panels) {
    const handle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', material(texture, panel.slices));
    world.spawn(
      { component: Transform, data: { pos: [panel.x, panel.y, 0], quat: [0, 0, 0, 1], scale: [panel.scale[0], panel.scale[1], 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_NINESLICE_QUAD } },
      { component: MeshRenderer, data: { materials: [handle] } },
    );
  }
  world.spawn({ component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } }, { component: Camera, data: orthographic({ left: -4.5, right: 4.5, bottom: -3, top: 3, near: 0.1, far: 100 }) });
}
