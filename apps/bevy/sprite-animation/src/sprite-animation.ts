// Shared scene and time-driven atlas animation for Bevy `sprite_animation`.

import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
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

export const FRAME_COUNT = 6;
export const FRAME_SIZE = 24;
export const ATLAS_WIDTH = FRAME_COUNT * FRAME_SIZE;
export const ATLAS_HEIGHT = FRAME_SIZE;
export const FRAME_DURATION_LEFT = 0.1;
export const FRAME_DURATION_RIGHT = 0.05;

export const SpriteAnimationMarker = defineComponent('SpriteAnimationMarker', {
  side: { type: 'u32' },
});

export function makeAtlasPixels(): Uint8Array {
  const data = new Uint8Array(ATLAS_WIDTH * ATLAS_HEIGHT * 4);
  const palette: readonly (readonly [number, number, number])[] = [
    [240, 72, 72], [245, 164, 48], [230, 215, 60], [70, 200, 120], [70, 150, 240], [180, 90, 230],
  ];
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const color = palette[frame] ?? [240, 240, 240];
    for (let y = 0; y < FRAME_SIZE; y++) {
      for (let x = 0; x < FRAME_SIZE; x++) {
        const localInside = x >= 3 && x <= 20 && y >= 4 && y <= 19;
        const stripe = localInside && ((x + frame * 3) % 7 === 0 || y === 4 + frame);
        const offset = (y * ATLAS_WIDTH + frame * FRAME_SIZE + x) * 4;
        data[offset] = stripe ? 255 : color[0];
        data[offset + 1] = stripe ? 255 : color[1];
        data[offset + 2] = stripe ? 255 : color[2];
        data[offset + 3] = localInside ? 255 : 0;
      }
    }
  }
  return data;
}

export function frameRegions(): Float32Array {
  const regions = new Float32Array(FRAME_COUNT * 4);
  const width = 1 / FRAME_COUNT;
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const offset = frame * 4;
    regions[offset] = frame * width;
    regions[offset + 1] = 0;
    regions[offset + 2] = width;
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

export function buildSpriteAnimationWorld(world: World, texture: number): void {
  const material = world.allocSharedRef('MaterialAsset', spriteMaterial(texture));
  const regions = frameRegions();
  for (const [x, side, duration] of [[-2.1, 0, FRAME_DURATION_LEFT], [2.1, 1, FRAME_DURATION_RIGHT] as const]) {
    world.spawn(
      { component: Transform, data: { pos: [x, 0, 0], quat: [0, 0, 0, 1], scale: [3, 3, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: SpriteAnimation, data: { frameCount: FRAME_COUNT, frameDuration: duration, currentFrame: 0, accumDt: 0, regions: new Float32Array(regions), playbackMode: SpritePlayback.loop } },
      { component: SpriteRegionOverride, data: { region: new Float32Array([0, 0, 1 / FRAME_COUNT, 1]) } },
      { component: SpriteAnimationMarker, data: { side } },
    );
  }
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -5, right: 5, bottom: -3, top: 3, near: 0.1, far: 100 }) },
  );
}

export function tickSpriteAnimation(world: World): void {
  const result = spriteAnimationTickSystem(world);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
}

export function readAnimationFrames(world: World): number[] {
  const query = world.query({ with: [SpriteAnimation, SpriteAnimationMarker] }).unwrap();
  const handles: EntityHandle[] = [];
  for (const row of query) handles.push(row.entity);
  return handles.map((entity) => {
    const result = world.get(entity, SpriteAnimation);
    return result.ok ? result.value.currentFrame : -1;
  });
}
