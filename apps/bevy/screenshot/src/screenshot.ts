// apps/bevy/screenshot — shared World builder + screenshot step
// (SSOT for the app AND the dawn smoke, imported by both via Node TS type-stripping).
//
// Reproduces Bevy's `window/screenshot` example (references/repos/bevy/
// examples/window/screenshot.rs): plane + cube + PointLight + camera,
// Space requests a screenshot from the host canvas.
// forgeax mapping:
//   - Screenshot::primary_window() -> host canvas capture → Uint8Array
//   - save_to_disk(path)           -> browser: download Blob; smoke: writeFileSync
//   - Camera3d + looking_at        -> Transform + Camera (perspective) + quat.fromLookAt

import { type World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { type MaterialAsset } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { quat } from '@forgeax/engine-math';

/**
 * Build the screenshot World: plane + cube + DirectionalLight + perspective camera.
 * Mirrors Bevy: Plane3d(5,5) + Cuboid + PointLight at (4,8,4) + Camera3d looking
 * from (-2,2.5,5) to origin.
 */
export function buildScreenshotWorld(world: World): void {
  // Plane — flat cube scaled to [5, 0.02, 5] (mirrors 3d-scene pattern)
  const planeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.3, 0.5, 0.3, 1.0] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [5, 0.02, 5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [planeMat] } },
  );

  // Cube at (0, 0.5, 0)
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.8, 0.7, 0.6, 1.0] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0.5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  );

  // PointLight at (4, 8, 4) — matches Bevy's reference
  world.spawn(
    { component: Transform, data: { pos: [4, 8, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 40 } },
  );

  // Camera — perspective, looking from (-2, 2.5, 5) at origin
  const eye: [number, number, number] = [-2, 2.5, 5];
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}

let wasSpaceDown = false;

/**
 * On Space rising edge, return true to signal a screenshot should be taken.
 * Caller (app or smoke) performs the host-owned capture separately.
 */
export function stepScreenshot(_world: World, snapshot: InputSnapshot | null): boolean {
  if (!snapshot) return false;

  const spaceDown = snapshot.keyboard.down(' ');
  const triggered = spaceDown && !wasSpaceDown;
  wasSpaceDown = spaceDown;
  return triggered;
}
