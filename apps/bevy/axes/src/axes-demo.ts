// apps/bevy/axes - shared World builder + axes-gizmo draw step (SSOT for the app AND the
// dawn smoke, imported by both via Node TS type-stripping so there is no duplicate-scene
// drift; memory smoke-script-duplicate-scene-must-stay-in-sync-with-main).
//
// Reproduces Bevy's `gizmos/axes` example (references/repos/bevy/examples/gizmos/axes.rs):
// each entity draws its local coordinate frame via `gizmos.axes(transform, length)` —
// three arrows (X=red, Y=green, Z=blue) along the transform's local axes.
//
// forgeax mapping:
//   - gizmos.axes(transform, length) -> app.debugDraw.axes(transform.world, length) — the new
//                                   DebugDraw gizmo primitive (solo round 20260713-222551).
//                                   Before it, DebugDraw had line/aabb/sphere/frustum only, so
//                                   drawing an entity's local frame meant hand-assembling
//                                   arrowhead segments + local-axis endpoints + the RGB convention.
//   - ShowAxes query               -> row iteration over tagged cubes, reading GlobalTransform.world
//
// drawAxesForEntities(world, debugDraw) is a pure function of (world, debugDraw) so the
// headless smoke can call it and assert the exact gizmo vertices (axis endpoints match the
// cubes' rotated local axes) — proving the gizmo reads local, not world, frames.

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';

/** Length of each drawn axis arrow (world units). */
export const AXIS_LENGTH = 1.5;

/** Tag marking cubes whose local axes are drawn. */
export const ShowAxes = defineComponent('ShowAxes', {
  marker: { type: 'u32', default: 1 },
});

/** The cubes' spawn poses: [position, yaw-pitch-roll] — distinct orientations so the axes visibly differ. */
const CUBES: ReadonlyArray<{ pos: [number, number, number]; euler: [number, number, number] }> = [
  { pos: [-3, 0, 0], euler: [0, 0, 0] },
  { pos: [0, 0, 0], euler: [Math.PI / 4, 0, 0] },
  { pos: [3, 0, 0], euler: [Math.PI / 5, Math.PI / 6, Math.PI / 7] },
];

/** Build the axes World: 3 differently-oriented cubes (each tagged ShowAxes) + light + camera. */
export function buildAxesWorld(world: World): void {
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.5, 0.5, 0.55, 1] }),
  );
  for (const { pos, euler } of CUBES) {
    const q = quat.fromEuler(quat.create(), euler[0], euler[1], euler[2], 'XYZ');
    world.spawn(
      {
        component: Transform,
        data: { pos, quat: [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1], scale: [0.7, 0.7, 0.7] },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [cubeMat] } },
      { component: ShowAxes, data: { marker: 1 } },
    );
  }

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.7, -0.5], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  const eye: [number, number, number] = [0, 3, 9];
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
}

/** Minimal structural type for the debug-draw handle both the app and smoke pass in. */
export interface AxesDrawTarget {
  axes(worldMat: ArrayLike<number>, length: number): void;
}

/**
 * Draw the local coordinate axes for every ShowAxes entity via debugDraw.axes,
 * reading each entity's world matrix (Bevy's `draw_axes` system). Pure function of
 * (world, debugDraw) — the app calls it each frame, the smoke calls it + inspects the
 * emitted gizmo vertices.
 */
export function drawAxesForEntities(world: World, debugDraw: AxesDrawTarget): void {
  const query = world.query({ with: [Transform, GlobalTransform, ShowAxes] }).unwrap();
  const handles: EntityHandle[] = [];
  for (const row of query) handles.push(row.entity);
  for (const handle of handles) {
    const t = world.get(handle, GlobalTransform);
    if (!t.ok) continue;
    debugDraw.axes(t.value.world, AXIS_LENGTH);
  }
}
