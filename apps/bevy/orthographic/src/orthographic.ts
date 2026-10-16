// apps/bevy/orthographic — shared orthographic camera scene and world builder.
//
// Bevy source (references/repos/bevy/examples/3d/orthographic.rs):
// "Shows how to create a 3D orthographic view (for isometric-look games or CAD
// applications)." A green plane + 4 brown cubes viewed from (5,5,5) with an
// orthographic projection (FixedVertical viewport_height=6.0), PointLight.
//
// forgeax mapping (thin over existing primitives — no engine gap):
//   - plane: flat-scaled HANDLE_CUBE, green PBR
//   - cubes: 4× HANDLE_CUBE at (±1.5, 0.5, ±1.5), brown PBR
//   - light: PointLight at (3,8,5)
//   - camera: orthographic projection at (5,5,5) looking at origin
//     bounds derived from Bevy's FixedVertical viewport_height=6.0 + 16:9 aspect

import { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { orthographic } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';

/** Bevy FixedVertical viewport_height=6.0 at 16:9 → width=10.667. */
const ORTHO_HEIGHT = 6; // Bevy's viewport_height
const ORTHO_WIDTH = ORTHO_HEIGHT * (16 / 9);

export function buildOrthographicWorld(world: World): void {
  // ── Green plane (5×5), flat at y=0 ────────────────────────────────────
  const planeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.3, 0.5, 0.3, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [5, 0.02, 5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [planeMat] } },
  );

  // ── 4 brown cubes at (±1.5, 0.5, ±1.5) ──────────────────────────────
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.8, 0.7, 0.6, 1] }),
  );
  for (const x of [-1.5, 1.5]) {
    for (const z of [-1.5, 1.5]) {
      world.spawn(
        { component: Transform, data: { pos: [x, 0.5, z], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [cubeMat] } },
      );
    }
  }

  // ── PointLight at (3,8,5) ────────────────────────────────────────────
  world.spawn(
    { component: Transform, data: { pos: [3, 8, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 40 } },
  );

  // ── Orthographic camera at (5,5,5) looking at origin ─────────────────
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [5, 5, 5],
        quat: quat.fromLookAt(quat.create(), [5, 5, 5], [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    {
      component: Camera,
      data: orthographic({
        left: -ORTHO_WIDTH / 2,
        right: ORTHO_WIDTH / 2,
        bottom: -ORTHO_HEIGHT / 2,
        top: ORTHO_HEIGHT / 2,
      }),
    },
  );
}
