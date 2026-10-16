import { quat } from '@forgeax/engine-math';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import type { World } from '@forgeax/engine-ecs';

export const SHADER_ID = 'bevy::shader_material';
export const TEXTURE_SIZE = 32;

export function makeTexturePixels(): Uint8Array {
  const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const offset = (y * TEXTURE_SIZE + x) * 4;
      const quadrant = (x < TEXTURE_SIZE / 2 ? 0 : 1) + (y < TEXTURE_SIZE / 2 ? 0 : 2);
      const colors: readonly [number, number, number][] = [
        [236, 54, 64],
        [47, 194, 116],
        [48, 110, 232],
        [242, 191, 52],
      ];
      const color = colors[quadrant] ?? [255, 255, 255];
      const border = x < 3 || y < 3 || x >= TEXTURE_SIZE - 3 || y >= TEXTURE_SIZE - 3;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = border ? 0 : 255;
    }
  }
  return pixels;
}

export function makeTextureAsset(pixels: Uint8Array): TextureAsset {
  return {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: TEXTURE_SIZE, height: TEXTURE_SIZE },
    },
    format: 'rgba8unorm-srgb',
    data: pixels,
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}

export function makeMaterial(texture: number): MaterialAsset {
  return {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: SHADER_ID }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } }],
    values: { baseColor: [0.82, 0.9, 1, 1], baseColorTexture: texture },
  };
}

export function buildShaderMaterialWorld(world: World, texture: number, aspect = 320 / 180): boolean {
  const geometry = createBoxGeometry(1.6, 1.6, 1.6);
  if (!geometry.ok) return false;
  const mesh = world.allocSharedRef('MeshAsset', geometry.value);
  const material = world.allocSharedRef('MaterialAsset', makeMaterial(texture));
  const eye: [number, number, number] = [2.6, 2.2, 5.2];
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]) } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect, near: 0.1, far: 100 }) },
  );
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0.5, -1, -0.5], color: [1, 1, 1], intensity: 1, castShadow: false },
  });
  return true;
}
