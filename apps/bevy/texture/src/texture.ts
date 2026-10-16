// apps/bevy/texture/src/texture.ts — shared scene for Bevy `texture` reproduction.
//
// Bevy source (references/repos/bevy/examples/3d/texture.rs): "various ways to
// configure texture materials in 3D" — 3 textured quads (normal, red-tinted,
// blue-tinted) with unlit baseColorTexture, alpha blend, and a camera.
//
// forgeax mapping (thin over existing primitives):
//   - procedural checkerboard texture (64x64 RGBA8-sRGB) as TextureAsset POD,
//     retained by the World shared-ref owner for lazy render residency
//   - 3 flat-scaled HANDLE_CUBE quads at z=-1.5/0/+1.5, each with a distinct
//     unlit material (white=normal, red-tinted, blue-tinted) sharing one texture
//   - unlit material with baseColorTexture — engine fix: UnlitOpts now accepts
//     baseColorTexture (the unlit WGSL shader already binds + samples it at
//     @group(1) @binding(2))
//   - camera at (0,0,5) looking along -Z at the quads

import { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';

export const CHECKER_SIZE = 64;
export const CHECKER_TILES = 8;

export function makeCheckerboardPixels(): Uint8Array {
  const TILE_PX = CHECKER_SIZE / CHECKER_TILES;
  const data = new Uint8Array(CHECKER_SIZE * CHECKER_SIZE * 4);
  for (let y = 0; y < CHECKER_SIZE; y++) {
    for (let x = 0; x < CHECKER_SIZE; x++) {
      const off = (y * CHECKER_SIZE + x) * 4;
      const tx = Math.floor(x / TILE_PX);
      const ty = Math.floor(y / TILE_PX);
      const white = (tx + ty) % 2 === 0;
      const v = white ? 255 : 0;
      data[off] = v;
      data[off + 1] = v;
      data[off + 2] = v;
      data[off + 3] = 255;
    }
  }
  return data;
}

/**
 * Build the texture demo world from the World-owned TextureAsset shared ref.
 */
export function buildTextureWorld(world: World, texId: number): void {
  const normalMat = world.allocSharedRef('MaterialAsset', Materials.unlit([1, 1, 1, 1], { baseColorTexture: texId }));
  const redMat = world.allocSharedRef('MaterialAsset', Materials.unlit([1, 0, 0, 0.5], { baseColorTexture: texId }));
  const blueMat = world.allocSharedRef('MaterialAsset', Materials.unlit([0, 0, 1, 0.5], { baseColorTexture: texId }));

  // Normal quad at z=1.5
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 1.5], quat: [0, 0, 0, 1], scale: [4, 1, 0.01] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [normalMat] } },
  );
  // Red-tinted quad at z=0
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [4, 1, 0.01] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [redMat] } },
  );
  // Blue-tinted quad at z=-1.5
  world.spawn(
    { component: Transform, data: { pos: [0, 0, -1.5], quat: [0, 0, 0, 1], scale: [4, 1, 0.01] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [blueMat] } },
  );

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: DirectionalLight, data: { color: [1, 1, 1], intensity: 1 } },
  );

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}
