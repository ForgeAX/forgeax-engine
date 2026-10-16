// apps/bevy/translation - shared World builder + move step (SSOT for the app AND
// the dawn smoke, imported by both via Node TS type-stripping so there is no
// duplicate-scene drift; memory smoke-script-duplicate-scene-must-stay-in-sync-
// with-main).
//
// Reproduces Bevy's `translation` example (references/repos/bevy/examples/
// transforms/translation.rs): a cube carrying a `Movable { spawn, max_distance,
// speed }` component slides back and forth along its own local X axis; an Update
// system reads the frame delta and does
// `transform.translation += transform.local_x() * speed * dt`, flipping `speed`
// when the cube drifts more than `max_distance` from its spawn. forgeax mapping:
//   - Movable { spawn, max_distance, speed } -> a user-defined component (game
//                                   behavior data belongs in the app, not the
//                                   engine)
//   - transform.local_x()        -> quat.right(vec3.create(), t.quat) — the new
//                                   ergonomic local-basis accessor (solo round
//                                   20260713-174912). Before it, a demo had to
//                                   hand-wire quat.transformVec3(out, q, [1,0,0])
//                                   AND know that +X is the "right" basis — the
//                                   footgun this round folds. The cube spawns
//                                   with a 45° yaw so its local X is a visibly
//                                   diagonal world direction, making the accessor
//                                   (not a hard-coded world axis) the thing under
//                                   test.
//   - Query<(&mut Transform, &mut Movable)> -> one row iterator over
//                                   the two writable components
//   - Res<Time>                  -> world.getResource(Time).delta (auto-provided
//                                   each frame by createApp's frame-loop)
//
// Like 3d-rotation this is a MOTION demo: the move step (stepMove) is a pure
// function of (world, dt) so the headless smoke can drive it deterministically
// and prove two frames at different times differ (motion, not a frozen render).

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat, vec3 } from '@forgeax/engine-math';

/** Units/second the cube slides along its local X (Bevy's `Movable { speed: 2.0 }`). */
export const MOVE_SPEED = 2.0;

/** Max distance from spawn before the slide direction flips (Bevy's `max_distance: 5.0`). */
export const MAX_DISTANCE = 5.0;

/** Initial yaw so local X is a diagonal world direction (makes quat.right meaningful). */
const INITIAL_YAW = Math.PI / 4;

/**
 * Per-entity movement state — mirrors Bevy's `Movable`. `spawn` is the origin the
 * `max_distance` band is measured from; `speed` is signed (flips at the band edge).
 * `defineComponent` registers the schema globally; `world.spawn` uses it directly.
 */
export const Movable = defineComponent('Movable', {
  spawn: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
  maxDistance: { type: 'f32', default: MAX_DISTANCE },
  speed: { type: 'f32', default: MOVE_SPEED },
});

/**
 * Build the translation World: a sliding cube + a ground plane + a directional
 * light + a camera looking at the origin. The cube starts yawed 45° so its local
 * X (the slide direction) is a diagonal world vector; stepMove advances it each
 * frame and reverses at the band edge.
 */
export function buildTranslationWorld(world: World): void {
  // ── Ground plane (flat-scaled cube), white PBR ────────────────────────
  const groundMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 1, 1, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, -1.5, 0], quat: [0, 0, 0, 1], scale: [16, 0.02, 16] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [groundMat] } },
  );

  // ── The sliding cube (Bevy Color::WHITE), yawed 45° at spawn ──────────
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.9, 0.9, 0.9, 1] }),
  );
  const spawnQuat = quat.eulerY(INITIAL_YAW);
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0],
        quat: [spawnQuat[0] ?? 0, spawnQuat[1] ?? 0, spawnQuat[2] ?? 0, spawnQuat[3] ?? 1],
        scale: [2, 2, 2],
      },
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
    { component: Movable, data: { spawn: [0, 0, 0], maxDistance: MAX_DISTANCE, speed: MOVE_SPEED } },
  );

  // ── Directional light aimed at the origin (Bevy DirectionalLight) ─────
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.5, -0.7, -0.5], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  // ── Camera at (0, 10, 20) looking at the origin (Bevy's setup) ────────
  const eye: [number, number, number] = [0, 10, 20];
  world.spawn(
    {
      component: Transform,
      data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}

/**
 * Advance every Movable entity's position by one frame of `dt` seconds.
 *
 * This is the pure move step — the same math whether it runs inside a
 * `world.addSystem` (the app) or a manual loop (the smoke). It reproduces Bevy's
 * `move_cube(Query<(&mut Transform, &mut Movable)>, Res<Time>)`:
 * `transform.translation += transform.local_x() * speed * dt`, flipping `speed`
 * when the cube leaves the `max_distance` band. `transform.local_x()` maps
 * directly to `quat.right(out, transform.quat)` — the ergonomic local-basis
 * accessor this round adds.
 */
export function stepMove(world: World, dt: number): void {
  const query = world.query({ with: [Transform, Movable] }).unwrap();
  const targets: Array<{ handle: EntityHandle }> = [];
  for (const row of query) targets.push({ handle: row.entity });
  const localX = vec3.create();
  for (const { handle } of targets) {
    const t = world.get(handle, Transform);
    const m = world.get(handle, Movable);
    if (!t.ok || !m.ok) continue;
    const pos = t.value.pos;
    const spawn = m.value.spawn;
    let speed = m.value.speed;

    // Flip direction if the cube drifted past max_distance from its spawn.
    const dx = (pos[0] ?? 0) - (spawn[0] ?? 0);
    const dy = (pos[1] ?? 0) - (spawn[1] ?? 0);
    const dz = (pos[2] ?? 0) - (spawn[2] ?? 0);
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > (m.value.maxDistance ?? MAX_DISTANCE)) {
      speed = -speed;
      world.set(handle, Movable, { speed });
    }

    // direction = transform.local_x()  →  quat.right(out, quat)
    quat.right(localX, t.value.quat);
    const step = speed * dt;
    world.set(handle, Transform, {
      pos: [
        (pos[0] ?? 0) + (localX[0] ?? 0) * step,
        (pos[1] ?? 0) + (localX[1] ?? 0) * step,
        (pos[2] ?? 0) + (localX[2] ?? 0) * step,
      ],
    });
  }
}
