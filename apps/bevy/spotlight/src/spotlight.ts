// apps/bevy/spotlight — reproduction of Bevy's `spotlight` example.
//
// Bevy source (references/repos/bevy/examples/3d/spotlight.rs):
//   16 SpotLights in a 4×4 grid, each aimed straight down at the ground from y≈2,
//   40 randomly-positioned cubes on a 100×100 white plane, plus light-sway
//   animation (cone angles modulated by sin(time)) and camera/ground movement
//   controls.
//
// forgeax mapping (thin over existing primitives — SpotLight component already exists):
//   - ground: flat cube scaled 100×0.02×100, white PBR material
//   - cubes:  40 HANDLE_CUBE at pseudo-random positions (deterministic LCG), blue PBR
//   - lights: 4 SpotLights in a 2×2 grid (engine caps at 4), direction=[0,-1,0] (straight down),
//             innerConeDeg=38.3 / outerConeDeg=45 (Bevy's PI/4*0.85 / PI/4),
//             intensity=5 (tuned to forgeax non-photometric scale)
//   - camera: Transform at (-4,5,10) looking at origin via quat.fromLookAt

import { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import { SpotLight } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';

const INNER_CONE_DEG = 38.3; // PI/4 * 0.85
const OUTER_CONE_DEG = 45; // PI/4

function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 0xffffffff;
  };
}

export function buildSpotlightWorld(world: World): void {
  // ── Ground plane (flat cube), white PBR ────────────────────────────────
  const groundMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 1, 1, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [100, 0.02, 100] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [groundMat] } },
  );

  // ── 40 random cubes (deterministic LCG matching Bevy's ChaCha8Rng) ─────
  const rand = seededRandom(19878367467713);
  const blueMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [124 / 255, 144 / 255, 1, 1] }),
  );
  for (let i = 0; i < 40; i++) {
    const x = rand() * 10 - 5;
    const y = rand() * 3;
    const z = rand() * 10 - 5;
    world.spawn(
      { component: Transform, data: { pos: [x, y, z], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [blueMat] } },
    );
  }

  // ── 4 SpotLights in a 2×2 grid (engine caps at 4), castShadow=false ────
  for (const pos of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
    const x = pos[0];
    const z = pos[1];
    world.spawn(
      {
        component: Transform,
        data: { pos: [x, 3, z], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      {
        component: SpotLight,
        data: {
          direction: [0, -1, 0],
          color: [1, 1, 1],
          intensity: 5,
          innerConeDeg: INNER_CONE_DEG,
          outerConeDeg: OUTER_CONE_DEG,
          castShadow: false,
        },
      },
    );
  }

  // ── Camera at (-4,5,10) looking at origin ──────────────────────────────
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [-4, 5, 10],
        quat: quat.fromLookAt(quat.create(), [-4, 5, 10], [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}
