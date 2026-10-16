// apps/bevy/lighting — reproduction of Bevy's `lighting` example.
//
// Bevy source (references/repos/bevy/examples/3d/lighting.rs):
//   Scene with all light types: red PointLight + green SpotLight + blue PointLight
//   + rotating DirectionalLight + orange-red ambient. Emissive light-gizmo children.
//   Movable objects (cube, sphere, logo quad) controlled by arrow keys.
//   Space toggles ambient light.
//
// forgeax mapping (thin over existing primitives — all light types exist):
//   - ground: flat cube scaled 10×0.02×10, white PBR
//   - left wall: cube scaled 5×0.15×5, rotated Z=90°, indigo PBR
//   - back wall: cube scaled 5×0.15×5, rotated X=90°, indigo PBR
//   - logo quad: flat quad, unlit white (no logo texture asset)
//   - pink cube: cube, pink PBR
//   - green sphere: sphere, green PBR
//   - red PointLight: at (1,2,0), with red emissive sphere child
//   - green SpotLight: at (-1,2,0), with green emissive sphere child, inner/outer cone
//   - blue PointLight: at (0,4,0), with blue emissive sphere child
//   - DirectionalLight: at (0,2,0), pointing down, shadow-casting
//   - Skylight: orange-red ambient
//   - camera: at (-2,2.5,5) looking at origin, perspective
//
// Static render — no per-frame animation needed. The scene proves all 4 light
// types (PointLight, SpotLight, DirectionalLight, Skylight) compose correctly.

import type { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_QUAD, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials, Skylight } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';
import { SpotLight } from '@forgeax/engine-render';

import type { MaterialAsset } from '@forgeax/engine-runtime';;
import { quat } from '@forgeax/engine-math';

// ── Light colors (Bevy RED / LIME / BLUE) ───────────────────────────────
const RED = [1, 0, 0] as const;
const LIME = [0, 1, 0] as const;
const BLUE = [0, 0, 1] as const;
// 4-component versions for baseColor (RGBA)
const RED4: [number, number, number, number] = [1, 0, 0, 1];
const LIME4: [number, number, number, number] = [0, 1, 0, 1];
const BLUE4: [number, number, number, number] = [0, 0, 1, 1];

export function buildLightingWorld(world: World): void {
  // ── Ground plane (flat cube), white PBR ─────────────────────────────────
  const whiteMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 1, 1, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [10, 0.02, 10] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [whiteMat] } },
  );

  // ── Left wall (cuboid 5.0×0.15×5.0, rotated Z=90°), indigo ────────────
  const indigoMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [75 / 255, 0, 130 / 255, 1] }),
  );
  const leftWallQuat = quat.create();
  quat.fromAxisAngle(leftWallQuat, [0, 0, 1], Math.PI / 2);
  world.spawn(
    { component: Transform, data: { pos: [2.5, 2.5, 0], quat: leftWallQuat, scale: [5, 0.15, 5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [indigoMat] } },
  );

  // ── Back wall (cuboid 5.0×0.15×5.0, rotated X=90°), indigo ────────────
  const backWallQuat = quat.create();
  quat.fromAxisAngle(backWallQuat, [1, 0, 0], Math.PI / 2);
  world.spawn(
    { component: Transform, data: { pos: [0, 2.5, -2.5], quat: backWallQuat, scale: [5, 0.15, 5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [indigoMat] } },
  );

  // ── Logo quad (unlit white, no logo texture asset) ──────────────────────
  const logoMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([1, 1, 1, 1]),
  );
  const logoQuat = quat.create();
  quat.fromAxisAngle(logoQuat, [0, 1, 0], Math.PI / 8);
  world.spawn(
    { component: Transform, data: { pos: [-2.2, 0.5, 1], quat: logoQuat, scale: [2, 0.5, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [logoMat] } },
  );

  // ── Pink cube (Bevy DEEP_PINK) ─────────────────────────────────────────
  const pinkMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 20 / 255, 147 / 255, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [pinkMat] } },
  );

  // ── Green sphere (Bevy LIMEGREEN) ──────────────────────────────────────
  const greenMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [50 / 255, 205 / 255, 50 / 255, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [1.5, 1, 1.5], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [greenMat] } },
  );

  // ── Red PointLight with emissive sphere child ───────────────────────────
  const redEmissiveMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: RED4, emissive: [4, 0, 0] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [1, 2, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: RED, intensity: 400, range: 20 } },
  );
  world.spawn(
    { component: Transform, data: { pos: [1, 2, 0], quat: [0, 0, 0, 1], scale: [0.1, 0.1, 0.1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [redEmissiveMat] } },
  );

  // ── Green SpotLight with emissive sphere child ──────────────────────────
  const greenEmissiveMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: LIME4, emissive: [0, 4, 0] }),
  );
  world.spawn(
    {
      component: Transform,
      data: { pos: [-1, 2, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    },
    {
      component: SpotLight,
      data: {
        direction: [0, -1, 0],
        color: LIME,
        intensity: 400,
        innerConeDeg: 34.4, // 0.6 rad
        outerConeDeg: 45.8, // 0.8 rad
        castShadow: true,
      },
    },
  );
  world.spawn(
    {
      component: Transform,
      data: { pos: [-1, 2, 0], quat: [0, 0, 0, 1], scale: [0.1, 0.1, 0.1] },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [greenEmissiveMat] } },
  );

  // ── Blue PointLight with emissive sphere child ──────────────────────────
  const blueEmissiveMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: BLUE4, emissive: [0, 0, 4] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 4, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: BLUE, intensity: 400, range: 20 } },
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 4, 0], quat: [0, 0, 0, 1], scale: [0.1, 0.1, 0.1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [blueEmissiveMat] } },
  );

  // ── DirectionalLight (sun) — pointing down, shadow-casting ──────────────
  const sunQuat = quat.create();
  quat.fromAxisAngle(sunQuat, [1, 0, 0], -Math.PI / 4);
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 2, 0], quat: sunQuat, scale: [1, 1, 1] },
    },
    {
      component: DirectionalLight,
      data: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 10, castShadow: true },
    },
  );

  // ── Skylight (ambient, orange-red) ──────────────────────────────────────
  world.spawn({
    component: Skylight,
    data: { color: new Float32Array([1, 0.27, 0]), intensity: 1 },
  });

  // ── Camera at (-2,2.5,5) looking at origin ──────────────────────────────
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [-2, 2.5, 5],
        quat: quat.fromLookAt(quat.create(), [-2, 2.5, 5], [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}
