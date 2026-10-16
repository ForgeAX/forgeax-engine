// Shared scene and subset animation for Bevy `sprite_sheet`.

import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { type World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import {
  SpriteAnimation,
  SpriteRegionOverride,
  SpritePlayback,
  SPRITE_PREMULTIPLIED_ALPHA_BLEND,
} from '@forgeax/engine-render/authoring';
import { spriteAnimationTickSystem } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

export const SHEET_FRAME_COUNT = 7;
export const FIRST_ANIMATION_FRAME = 1;
export const LAST_ANIMATION_FRAME = 6;
export const ANIMATION_FRAME_COUNT = LAST_ANIMATION_FRAME - FIRST_ANIMATION_FRAME + 1;
export const FRAME_SIZE = 24;
export const SHEET_WIDTH = SHEET_FRAME_COUNT * FRAME_SIZE;
export const SHEET_HEIGHT = FRAME_SIZE;
export const FRAME_DURATION = 0.1;

const COLORS: readonly (readonly [number, number, number])[] = [
  [255, 30, 200],
  [238, 72, 72],
  [245, 164, 48],
  [230, 215, 60],
  [70, 200, 120],
  [70, 150, 240],
  [180, 90, 230],
] as const;

export function makeSpriteSheetPixels(): Uint8Array {
  const pixels = new Uint8Array(SHEET_WIDTH * SHEET_HEIGHT * 4);
  for (let frame = 0; frame < SHEET_FRAME_COUNT; frame += 1) {
    const color = COLORS[frame]!;
    for (let y = 0; y < FRAME_SIZE; y += 1) {
      for (let x = 0; x < FRAME_SIZE; x += 1) {
        const dx = x - FRAME_SIZE / 2 + 0.5;
        const dy = y - FRAME_SIZE / 2 + 0.5;
        const inside = dx * dx + dy * dy <= 9.5 * 9.5;
        const stripe = inside && ((x + frame * 2) % 7 === 0 || y === 5 + frame % 8);
        const offset = (y * SHEET_WIDTH + frame * FRAME_SIZE + x) * 4;
        pixels[offset] = stripe ? 255 : color[0];
        pixels[offset + 1] = stripe ? 255 : color[1];
        pixels[offset + 2] = stripe ? 255 : color[2];
        pixels[offset + 3] = inside ? 255 : 0;
      }
    }
  }
  return pixels;
}

export function animationRegions(): Float32Array {
  const regions = new Float32Array(ANIMATION_FRAME_COUNT * 4);
  for (let logicalFrame = 0; logicalFrame < ANIMATION_FRAME_COUNT; logicalFrame += 1) {
    const sourceFrame = FIRST_ANIMATION_FRAME + logicalFrame;
    const offset = logicalFrame * 4;
    regions[offset] = sourceFrame / SHEET_FRAME_COUNT;
    regions[offset + 1] = 0;
    regions[offset + 2] = 1 / SHEET_FRAME_COUNT;
    regions[offset + 3] = 1;
  }
  return regions;
}

function spriteMaterial(texture: number): MaterialAsset {
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
    values: { colorTint: [1, 1, 1, 1], baseColorTexture: texture, pivotAndSize: [0.5, 0.5, 1, 1] },
  };
}

export function buildSpriteSheetWorld(world: World, texture: number): void {
  const material = world.allocSharedRef('MaterialAsset', spriteMaterial(texture));
  const regions = animationRegions();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [5, 5, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [material] } },
    { component: SpriteAnimation, data: { frameCount: ANIMATION_FRAME_COUNT, frameDuration: FRAME_DURATION, currentFrame: 0, accumDt: 0, regions, playbackMode: SpritePlayback.loop } },
    { component: SpriteRegionOverride, data: { region: new Float32Array(regions.slice(0, 4)) } },
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -8, right: 8, bottom: -4.5, top: 4.5, near: 0.1, far: 100 }) },
  );
}

export function tickSpriteSheet(world: World): void {
  const result = spriteAnimationTickSystem(world);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
}
