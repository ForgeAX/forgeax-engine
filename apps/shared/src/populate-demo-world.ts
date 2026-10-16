// apps/shared/src/populate-demo-world.ts - shared demo World bootstrap helper.
//
// (feat-20260514-ci-jscpd-duplication-gate M3 T-014; clone #2 cash-out path-A.)
//
// Why this exists: jscpd reported clone #2
//   apps/hello/cube/src/main.ts:20-58 <-> apps/inspector-demo/src/main.ts:32-70
//   (38 lines, typescript)
// as the verbatim 3-entity (cube + camera + directional light) ECS spawn block. plan-strategy
// D-P4 row + requirements C-3 / C-5 / C-6 + AC-13 path-A mandate extraction into a sibling
// helper module under `apps/shared/src/` (no workspace package; consumers import via
// relative path). File + directory names carry no underscore prefix per C-4 / C-6.
//
// Lock values mirror the hello-triangle / hello-cube M0 SSOT (charter proposition 5
// co-source binding exemplar): cube at origin (silent default mid-grey material from
// the merged-MeshRenderer empty-spawn path; D-Q7 case B), perspective camera at z=3,
// directional light pointing diagonally down-and-back. NDC center pixel distance to
// black stays >> 0.05 for the hello-cube smoke verdict.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export function populateDemoWorld(world: World): void {
  // Cube entity: builtin geometry + identity transform + empty MeshRenderer
  // (D-Q7 case B: missing material handle routes the silent mid-grey default).
  world
    .spawn(
      {
        component: Transform,
        data: {},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      {
        component: MeshRenderer,
        data: {},
      },
    )
    .unwrap();
  // Active Camera entity (mirrors hello-cube SSOT lock values).
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 3] },
      },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
    )
    .unwrap();
  // Active DirectionalLight entity (mirrors hello-cube SSOT lock values).
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -1, -0.3],
        color: [1, 1, 1],
        intensity: 1,
      },
    })
    .unwrap();
}
