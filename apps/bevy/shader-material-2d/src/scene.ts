import type { World } from '@forgeax/engine-ecs';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';

export const SHADER_ID = 'bevy::shader_material_2d';
export const TEXTURE_SIZE = 64;

function makeQuad(): MeshAsset {
  const vertices = new Float32Array([
    -1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 1,
    1, -1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1,
    -1, -1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1,
  ]);
  return {
    kind: 'mesh',
    vertices,
    attributes: {
      position: new Float32Array([-1, 1, 0, 1, 1, 0, 1, -1, 0, -1, -1, 0]),
      normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    },
    indices: new Uint32Array([0, 3, 2, 0, 2, 1]),
    submeshes: [{ indexOffset: 0, indexCount: 6, vertexCount: 4, topology: 'triangle-list', materialSlot: 0 }],
    aabb: new Float32Array([-1, -1, 0, 1, 1, 0]),
    materialSlots: [{ slotName: 'Default' }],
  };
}

const QUAD = makeQuad();

export function makeTexturePixels(): Uint8Array {
  const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const center = (TEXTURE_SIZE - 1) / 2;
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const inside = Math.hypot(dx, dy) < 27;
      const stripe = inside && (Math.abs(dx - dy) < 3 || Math.abs(dx + dy) < 3);
      const offset = (y * TEXTURE_SIZE + x) * 4;
      pixels[offset] = stripe ? 255 : 35;
      pixels[offset + 1] = stripe ? 215 : 155;
      pixels[offset + 2] = stripe ? 70 : 245;
      pixels[offset + 3] = inside ? 255 : 0;
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
    passes: [{
      name: 'Forward',
      program: { module: SHADER_ID },
      renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
    }],
    values: { baseColor: [0.35, 0.8, 1, 1], baseColorTexture: texture },
  };
}

export function buildShaderMaterial2dWorld(world: World, texture: number, aspect = 320 / 180): void {
  const mesh = world.allocSharedRef('MeshAsset', QUAD);
  const material = world.allocSharedRef('MaterialAsset', makeMaterial(texture));
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 1], scale: [1.55, 1.55, 1] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
  const halfHeight = 2.25;
  const halfWidth = halfHeight * Math.max(aspect, 0.1);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 10] } },
    { component: Camera, data: orthographic({ left: -halfWidth, right: halfWidth, bottom: -halfHeight, top: halfHeight, near: 0.1, far: 100 }) },
  );
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
  });
}
