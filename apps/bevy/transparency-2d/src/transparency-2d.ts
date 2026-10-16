import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

export const TEXTURE_SIZE = 48;
export const DEFAULT_ALPHAS = [1, 0.7, 0.35] as const;

export function makeTransparencyPixels(): Uint8Array {
  const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const center = (TEXTURE_SIZE - 1) / 2;
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const dx = x - center;
      const dy = y - center;
      const distance = Math.hypot(dx, dy);
      const inside = distance < 20;
      const stripe = inside && (Math.abs(dx - dy) < 3 || Math.abs(dx + dy) < 3);
      const offset = (y * TEXTURE_SIZE + x) * 4;
      pixels[offset] = stripe ? 255 : 235;
      pixels[offset + 1] = stripe ? 235 : 80;
      pixels[offset + 2] = stripe ? 70 : 80;
      pixels[offset + 3] = inside ? 255 : 0;
    }
  }
  return pixels;
}

function spriteMaterial(texture: number, color: readonly [number, number, number, number]): MaterialAsset {
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
    values: { colorTint: color, baseColorTexture: texture, pivotAndSize: [0.5, 0.5, 1, 1] },
  };
}

export function buildTransparencyWorld(world: World, texture: number, alphas: readonly [number, number, number] = DEFAULT_ALPHAS): void {
  const colors: readonly (readonly [number, number, number, number])[] = [
    [1, 1, 1, alphas[0]],
    [0.1, 0.25, 1, alphas[1]],
    [0.1, 1, 0.25, alphas[2]],
  ];
  const positions: readonly (readonly [number, number, number])[] = [[-0.9, 0, 0], [0, 0, 0.1], [0.9, 0, 0.2]];
  for (let i = 0; i < positions.length; i++) {
    const material = world.allocSharedRef('MaterialAsset', spriteMaterial(texture, colors[i]!));
    world.spawn(
      { component: Transform, data: { pos: positions[i]!, quat: [0, 0, 0, 1], scale: [2.8, 2.8, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [material] } },
    );
  }
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -3.8, right: 3.8, bottom: -2.2, top: 2.2, near: 0.1, far: 100 }) },
  );
}
