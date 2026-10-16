// apps/bevy/pbr — shared PBR material grid scene and world builder.
//
// Bevy source (references/repos/bevy/examples/3d/pbr.rs):
// "This example shows how to configure Physically Based Rendering (PBR)
// parameters." 11×5 sphere grid with metallic (y-axis) and roughness (x-axis)
// varying per sphere, plus an unlit sphere below the grid, DirectionalLight,
// and orthographic camera.
//
// forgeax mapping (thin over existing primitives — no engine gap):
//   - spheres: 11×5 grid of HANDLE_SPHERE, each with Materials.standard
//     { baseColor, metallic, roughness } varying per grid position
//   - unlit sphere: HANDLE_SPHERE at (-5, -2.5, 0), Materials.unlit
//   - light: DirectionalLight at (50,50,50) looking at origin
//   - camera: orthographic projection at (0,0,8) looking at origin
//   - skipped: environment map (not the demo's core visual), UI text labels
//     (no UI subsystem)
//
// Bevy baseColor: Srgba::hex("#ffd891") = (0xff, 0xd8, 0x91) / 255
//   ≈ [1.0, 0.847, 0.569] linear sRGB

import { World } from '@forgeax/engine-ecs';
import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { orthographic } from '@forgeax/engine-render';
import { Materials, Skylight } from '@forgeax/engine-render';

import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';

const GOLD: [number, number, number, number] = [1.0, 0.847, 0.569, 1.0];

export function buildPbrWorld(world: World): void {
  // ── 11×5 PBR sphere grid (x: -5..5, y: -2..2) ───────────────────────
  for (let y = -2; y <= 2; y++) {
    for (let x = -5; x <= 5; x++) {
      const x01 = (x + 5) / 10; // roughness: 0→1 left-to-right
      const y01 = (y + 2) / 4;  // metallic: 0→1 bottom-to-top
      const mat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
        'MaterialAsset',
        Materials.standard({ baseColor: GOLD, metallic: y01, roughness: x01 }),
      );
      world.spawn(
        { component: Transform, data: { pos: [x, y + 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
        { component: MeshRenderer, data: { materials: [mat] } },
      );
    }
  }

  // ── Unlit sphere below the grid at (-5, -2.5, 0) ────────────────────
  const unlitMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit(GOLD),
  );
  world.spawn(
    { component: Transform, data: { pos: [-5, -2.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [unlitMat] } },
  );

  // ── DirectionalLight ─────────────────────────────────────────────────
  world.spawn(
    { component: Transform, data: { pos: [0, 2, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: DirectionalLight, data: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 10, castShadow: false } },
  );

  // ── Skylight (ambient) ────────────────────────────────────────────────
  world.spawn({
    component: Skylight,
    data: { color: new Float32Array([0.1, 0.1, 0.1]), intensity: 0.5 },
  });

  // ── Orthographic camera at (0,0,8) looking at origin ─────────────────
  // Bevy uses ScalingMode::WindowSize(scale=0.01) → viewport height ≈
  // pixels * 0.01 world units. At 800px ≈ 8 units tall, matching the grid
  // (x: -5..5, y: -2..2). Fixed bounds: 16:9 → 14.22×8.
  const camQuat = quat.create();
  quat.fromLookAt(camQuat, [0, 0, 8], [0, 0, 0], [0, 1, 0]);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 8], quat: camQuat, scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -7.11, right: 7.11, bottom: -4, top: 4 }) },
  );
}
