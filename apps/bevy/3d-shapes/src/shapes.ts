// apps/bevy/3d-shapes - shared World recipe (imported by both src/main.ts and
// scripts/smoke-dawn.mjs so the browser app and the headless smoke build the
// EXACT same scene — memory smoke-script-duplicate-scene-must-stay-in-sync-with-
// main: a single SSOT builder avoids the two drifting).
//
// Bevy source (references/repos/bevy/examples/3d/3d_shapes.rs): a row of shape
// primitives (Cuboid / Sphere / Cylinder / Capsule3d / Torus / Cone / …) each
// meshed and placed along X, lit and viewed from a fixed camera. We reproduce
// the primitive-gallery intent with forgeax's 7 procedural factories, placing
// one of each along X. The CAPSULE sits at the center (x=0) so the smoke's
// NDC-center pixel check lands on this round's new primitive.

import type { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createCapsuleGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createSphereGeometry,
  createTorusGeometry,
} from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';
import type { AssetError, MaterialAsset } from '@forgeax/engine-runtime';
import type { MeshAsset, Result } from '@forgeax/engine-types';
import { quat } from '@forgeax/engine-math';

// A row of 7 primitives. The capsule is index 3 (center) so it renders at x=0.
// Each entry: label + a factory call returning Result<MeshAsset, AssetError> +
// an authored sRGB-ish base color (parity with Bevy's per-shape debug palette;
// forgeax has no runtime UV-debug-texture path yet, so we tint by color to keep
// the shapes visually distinct — a workaround-free simplification, not a gap).
type ShapeSpec = {
  readonly label: string;
  readonly mesh: () => Result<MeshAsset, AssetError>;
  readonly color: readonly [number, number, number];
};

const SHAPES: readonly ShapeSpec[] = [
  { label: 'box', mesh: () => createBoxGeometry(1, 1, 1), color: [0.85, 0.3, 0.3] },
  { label: 'cone', mesh: () => createConeGeometry(0.6, 1.2, 24), color: [0.9, 0.6, 0.2] },
  { label: 'cylinder', mesh: () => createCylinderGeometry(0.5, 0.5, 1.2, 24), color: [0.85, 0.85, 0.25] },
  // center (x=0): the new capsule primitive
  { label: 'capsule', mesh: () => createCapsuleGeometry(0.45, 0.9, 6, 24), color: [0.3, 0.8, 0.4] },
  { label: 'sphere', mesh: () => createSphereGeometry(0.6, 24, 18), color: [0.3, 0.6, 0.9] },
  { label: 'torus', mesh: () => createTorusGeometry(0.5, 0.2, 24, 16), color: [0.5, 0.4, 0.85] },
  { label: 'cylinder-tall', mesh: () => createCylinderGeometry(0.35, 0.35, 1.6, 24), color: [0.85, 0.4, 0.7] },
];

const SPACING = 2.0;

/**
 * Populate `world` with the 3d_shapes gallery: a ground plane, a row of the 7
 * procedural primitives centered on the capsule, a point light, and a camera.
 * Returns the count of shapes actually placed (fail-fast: a degenerate factory
 * result is a hard error — this is a demo of the factories working).
 */
export function buildShapesWorld(world: World): number {
  // Ground plane (flat-scaled cube), light gray PBR.
  const groundMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.6, 0.6, 0.62, 1] }),
  );
  const groundMesh = createBoxGeometry(1, 1, 1);
  if (!groundMesh.ok) throw new Error(`3d-shapes: ground box failed: ${groundMesh.error.code}`);
  const groundHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', groundMesh.value);
  world.spawn(
    { component: Transform, data: { pos: [0, -0.75, 0], quat: [0, 0, 0, 1], scale: [18, 0.1, 6] } },
    { component: MeshFilter, data: { assetHandle: groundHandle } },
    { component: MeshRenderer, data: { materials: [groundMat] } },
  );

  const n = SHAPES.length;
  const x0 = -((n - 1) / 2) * SPACING;
  let placed = 0;
  for (let i = 0; i < n; i++) {
    const spec = SHAPES[i];
    if (spec === undefined) continue;
    const res = spec.mesh();
    if (!res.ok) throw new Error(`3d-shapes: ${spec.label} failed: ${res.error.code}`);
    const meshHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', res.value);
    const mat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      Materials.standard({ baseColor: [spec.color[0], spec.color[1], spec.color[2], 1] }),
    );
    world.spawn(
      { component: Transform, data: { pos: [x0 + i * SPACING, 0.1, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [mat] } },
    );
    placed++;
  }

  // Point light above the row (intensity=400 matches the Bevy-parity anchor
  // established in solo round 20260713-141636; forgeax intensity is a raw 1/d^2
  // multiplier — see solo/AGENTS.md deferred PointLight photometric note).
  world.spawn(
    { component: Transform, data: { pos: [2, 8, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 60 } },
  );

  // Camera looking at the row center from front-above via quat.fromLookAt.
  const eye: [number, number, number] = [0, 3.5, 12];
  world.spawn(
    {
      component: Transform,
      data: {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  return placed;
}
