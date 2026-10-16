// apps/bevy/iter-combinations - shared World builder + N-body step (SSOT for the
// app AND the dawn smoke, imported by both via Node TS type-stripping so there is
// no duplicate-scene drift; memory smoke-script-duplicate-scene-must-stay-in-sync-
// with-main).
//
// Reproduces Bevy's `iter_combinations` example (references/repos/bevy/examples/
// ecs/iter_combinations.rs): an N-body gravity simulation where every pair of
// bodies attracts the other, applied ONCE per unordered pair via
// `query.iter_combinations_mut()`, then verlet-integrated. Bodies clump over time.
//
// forgeax mapping:
//   - query.iter_combinations_mut() -> query.combinations(2), the pairwise
//                                   iterator. Before it, a pairwise system had to
//                                   run a row query, collect handles, then
//                                   collect handles → hand-write a nested
//                                   for i/for j=i+1 loop. forgeax's world.get/set
//                                   Result model needs no mutable-aliasing cursor
//                                   (Bevy's iter_combinations_mut exists only for
//                                   Rust's borrow checker).
//   - Mass / Acceleration / LastPos -> user-defined components (game data in app)
//   - verlet integrate              -> stepIntegrate (pure world+dt function)
//   - Res<Time>                     -> world.getResource(Time).delta (auto by createApp)
//
// To keep the smoke deterministic (assert an exact clump), bodies start on a fixed
// ring with a tangential drift — no RNG (Bevy seeds a PRNG; the interaction math is
// what's under test, not the initial scatter). A central heavy "star" pulls them in.

import {
  defineComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';

/**
 * Newtonian constant scaled for a FAST, watchable clump — tuned so the ring
 * collapses decisively within the CI smoke's 100-frame budget (not just the local
 * 300). Bevy's own value is arbitrary; the pairwise interaction is what's under
 * test, so the timescale is a demo-tuning knob (solo LESSONS L5/L6: a convergence/
 * clump smoke must move the physical quantity that sets the margin, at the SMALLEST
 * frame budget any CI lane uses).
 */
export const GRAVITY_CONSTANT = 2.5;

/** Number of orbiting bodies (Bevy uses 100; a handful keeps the demo legible). */
export const NUM_BODIES = 8;

/** Ring radius the bodies start on. */
const RING_RADIUS = 6.0;

/** Body mass (uniform, for a symmetric clump). */
const BODY_MASS = 1.0;

/** Central star mass — dominant attractor that pulls the ring inward. */
const STAR_MASS = 40.0;

/**
 * Per-body physics state. `mass` weights the gravitational force; `acc` accumulates
 * per-frame force (reset each integrate); `lastPos` backs verlet integration.
 */
export const Body = defineComponent('Body', {
  mass: { type: 'f32', default: BODY_MASS },
  acc: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
  lastPos: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
});

/**
 * Build the N-body World: a ring of equal bodies + a heavy central star (also a
 * Body so it participates in the pairwise attraction) + a directional light +
 * a camera looking down at the ring.
 */
export function buildIterCombinationsWorld(world: World): void {
  const bodyMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.6, 0.7, 0.9, 1] }),
  );
  const starMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1.0, 0.4, 0.15, 1], emissive: [1.0, 0.3, 0.1] }),
  );

  // Ring of bodies, evenly spaced. Start lastPos == pos (zero initial velocity)
  // so the star's pull is what sets them in motion — a deterministic inward clump.
  for (let i = 0; i < NUM_BODIES; i++) {
    const theta = (i / NUM_BODIES) * Math.PI * 2;
    const x = Math.cos(theta) * RING_RADIUS;
    const z = Math.sin(theta) * RING_RADIUS;
    world.spawn(
      { component: Transform, data: { pos: [x, 0, z], quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
      { component: MeshRenderer, data: { materials: [bodyMat] } },
      { component: Body, data: { mass: BODY_MASS, acc: [0, 0, 0], lastPos: [x, 0, z] } },
    );
  }

  // Central star (heavier Body) at the origin.
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1.2, 1.2, 1.2] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [starMat] } },
    { component: Body, data: { mass: STAR_MASS, acc: [0, 0, 0], lastPos: [0, 0, 0] } },
  );

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.3, -0.9, -0.3], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  // Camera looking straight down the ring plane from above + back (sees the clump).
  const eye: [number, number, number] = [0, 14, 14];
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

function collectBodyHandles(world: World): EntityHandle[] {
  const query = world.query({ with: [Transform, Body] }).unwrap();
  const handles: EntityHandle[] = [];
  for (const row of query) handles.push(row.entity);
  return handles;
}

/**
 * Accumulate the pairwise gravitational force into every body's `acc`, applying
 * each unordered PAIR exactly once via `query.combinations(2)` — the direct
 * transcription of Bevy's `interact_bodies` (`query.iter_combinations_mut()`).
 */
export function stepInteract(world: World): void {
  const query = world.query({ with: [Transform, Body] }).unwrap();
  for (const pair of query.combinations(2)) {
    const a = pair[0]?.entity;
    const b = pair[1]?.entity;
    if (a === undefined || b === undefined) continue;
    const ta = world.get(a, Transform);
    const tb = world.get(b, Transform);
    const ba = world.get(a, Body);
    const bb = world.get(b, Body);
    if (!ta.ok || !tb.ok || !ba.ok || !bb.ok) continue;

    const pa = ta.value.pos;
    const pb = tb.value.pos;
    const dx = (pb[0] ?? 0) - (pa[0] ?? 0);
    const dy = (pb[1] ?? 0) - (pa[1] ?? 0);
    const dz = (pb[2] ?? 0) - (pa[2] ?? 0);
    const distSq = dx * dx + dy * dy + dz * dz + 0.5; // softening avoids singularity
    const f = GRAVITY_CONSTANT / distSq;
    const inv = 1 / Math.sqrt(distSq);
    // force per unit mass along the a→b direction
    const fx = dx * inv * f;
    const fy = dy * inv * f;
    const fz = dz * inv * f;

    const ma = ba.value.mass ?? BODY_MASS;
    const mb = bb.value.mass ?? BODY_MASS;
    const aa = ba.value.acc;
    const ab = bb.value.acc;
    // Newton's third law: a pulled toward b by mb, b pulled toward a by ma.
    world.set(a, Body, {
      acc: [(aa[0] ?? 0) + fx * mb, (aa[1] ?? 0) + fy * mb, (aa[2] ?? 0) + fz * mb],
    });
    world.set(b, Body, {
      acc: [(ab[0] ?? 0) - fx * ma, (ab[1] ?? 0) - fy * ma, (ab[2] ?? 0) - fz * ma],
    });
  }
}

/**
 * Verlet-integrate every body one step of `dt`, then zero its accumulated force
 * (Bevy's `integrate`): x(t+dt) = 2x(t) − x(t−dt) + a·dt².
 */
export function stepIntegrate(world: World, dt: number): void {
  const dtSq = dt * dt;
  for (const handle of collectBodyHandles(world)) {
    const t = world.get(handle, Transform);
    const body = world.get(handle, Body);
    if (!t.ok || !body.ok) continue;
    const pos = t.value.pos;
    const last = body.value.lastPos;
    const acc = body.value.acc;
    const nx = (pos[0] ?? 0) * 2 - (last[0] ?? 0) + (acc[0] ?? 0) * dtSq;
    const ny = (pos[1] ?? 0) * 2 - (last[1] ?? 0) + (acc[1] ?? 0) * dtSq;
    const nz = (pos[2] ?? 0) * 2 - (last[2] ?? 0) + (acc[2] ?? 0) * dtSq;
    world.set(handle, Body, {
      lastPos: [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0],
      acc: [0, 0, 0],
    });
    world.set(handle, Transform, { pos: [nx, ny, nz] });
  }
}

/** Max distance of any body from the origin — the smoke's clump probe (shrinks as bodies fall in). */
export function bodySpread(world: World): number {
  let maxDist = 0;
  for (const handle of collectBodyHandles(world)) {
    const t = world.get(handle, Transform);
    if (!t.ok) continue;
    const p = t.value.pos;
    const d = Math.sqrt((p[0] ?? 0) ** 2 + (p[1] ?? 0) ** 2 + (p[2] ?? 0) ** 2);
    if (d > maxDist) maxDist = d;
  }
  return maxDist;
}
