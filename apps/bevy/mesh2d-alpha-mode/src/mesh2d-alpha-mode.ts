import type { World } from '@forgeax/engine-ecs';
import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import type { MaterialAsset } from '@forgeax/engine-types';
import { Transform } from '@forgeax/engine-scene';

export const TEXTURE_SIZE = 48;

export function makeAlphaModePixels(): Uint8Array {
  const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const center = (TEXTURE_SIZE - 1) / 2;
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const dx = x - center;
      const dy = y - center;
      const inside = Math.hypot(dx, dy) < 18;
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

function material(
  texture: number,
  color: readonly [number, number, number, number],
  mode: 'opaque' | 'mask' | 'blend',
): MaterialAsset {
  return Materials.unlit(color, {
    baseColorTexture: texture,
    ...(mode === 'mask' ? { alphaCutoff: 0.5 } : {}),
    ...(mode === 'blend' ? { renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, queue: 3000 } : {}),
  });
}

function spawnPanel(world: World, texture: number, pos: readonly [number, number, number], color: readonly [number, number, number, number], mode: 'opaque' | 'mask' | 'blend'): void {
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', material(texture, color, mode));
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [2.4, 2.4, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  );
}

export function buildMesh2dAlphaModeWorld(world: World, texture: number): void {
  spawnPanel(world, texture, [-2.7, 0, 0], [1, 1, 1, 1], 'opaque');
  spawnPanel(world, texture, [-1.8, 0, 1], [0.1, 0.25, 1, 1], 'opaque');
  spawnPanel(world, texture, [-0.9, 0, -1], [0.1, 1, 0.25, 1], 'opaque');
  spawnPanel(world, texture, [1.8, 0, 0], [1, 1, 1, 1], 'mask');
  spawnPanel(world, texture, [2.7, 0, 1], [0.1, 0.25, 1, 0.7], 'blend');
  spawnPanel(world, texture, [3.6, 0, -1], [0.1, 1, 0.25, 0.7], 'blend');
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -5.2, right: 5.2, bottom: -2.2, top: 2.2, near: 0.1, far: 100 }) },
  );
}
