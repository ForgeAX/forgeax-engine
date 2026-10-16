// apps/bevy/time-elapsed - shared World builder + elapsed-keyed step (SSOT for the
// app AND the dawn smoke, imported by both via Node TS type-stripping so there is no
// duplicate-scene drift; memory smoke-script-duplicate-scene-must-stay-in-sync-with-main).
//
// Reproduces the spirit of Bevy's `time/time` example (references/repos/bevy/examples/
// time/time.rs): behavior keyed to ABSOLUTE elapsed time (Time::elapsed), not per-frame
// delta. Here a cube oscillates vertically as `y = amplitude * sin(elapsed * omega)` and
// pulses in scale — both pure functions of the elapsed clock.
//
// forgeax mapping:
//   - Res<Time>.elapsed_secs() -> world.getResource('Time').elapsed — the accumulated-
//                                 seconds field added in solo round 20260713-212920. Before
//                                 it, the Time resource was { dt } only, so an absolute-time
//                                 animation had to hand-accumulate dt in its own system
//                                 (drift + re-derivation). Now the frame-loop owns the one
//                                 elapsed accumulator and every system reads it.
//   - Update system            -> world.addSystem reading Time.elapsed each frame.
//
// stepByElapsed(world, elapsed) is a pure function of (world, elapsed) so the headless
// smoke can drive it deterministically (feeding a synthetic elapsed) and assert the
// cube's position matches the closed-form sin curve — proving the motion is elapsed-keyed.

import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { quat } from '@forgeax/engine-math';

/** Vertical oscillation amplitude (world units). */
export const AMPLITUDE = 2.0;
/** Angular frequency of the oscillation (rad/s). */
export const OMEGA = 1.5;
/** Base uniform scale; pulses by ±PULSE around this. */
const BASE_SCALE = 1.0;
const PULSE = 0.3;

/** Tag marking the elapsed-driven cube. */
export const Oscillator = defineComponent('Oscillator', {
  marker: { type: 'u32', default: 1 },
});

/** Closed-form vertical position for a given elapsed time — the correctness reference. */
export function oscillatorY(elapsed: number): number {
  return AMPLITUDE * Math.sin(elapsed * OMEGA);
}

/**
 * Build the time-elapsed World: an oscillating cube + a ground plane + a directional
 * light + a camera. The cube's position/scale are set by stepByElapsed each frame.
 */
export function buildTimeElapsedWorld(world: World): void {
  const groundMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.3, 0.3, 0.35, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, -3, 0], quat: [0, 0, 0, 1], scale: [16, 0.02, 16] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [groundMat] } },
  );

  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.9, 0.5, 0.2, 1] }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
    { component: Oscillator, data: { marker: 1 } },
  );

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.7, -0.5], color: [1, 1, 1], intensity: 3, castShadow: false },
  });

  const eye: [number, number, number] = [0, 2, 12];
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

/**
 * Set every Oscillator entity's position + scale from the ABSOLUTE elapsed time
 * (Bevy's Time::elapsed-keyed animation): `y = AMPLITUDE * sin(elapsed * OMEGA)`,
 * scale pulses as `BASE_SCALE + PULSE * sin(elapsed * OMEGA)`. Pure function of
 * (world, elapsed) — no per-frame dt accumulation.
 */
export function stepByElapsed(world: World, elapsed: number): void {
  const query = world.query({ with: [Transform, Oscillator] }).unwrap();
  const handles: EntityHandle[] = [];
  for (const row of query) handles.push(row.entity);
  const y = oscillatorY(elapsed);
  const s = BASE_SCALE + PULSE * Math.sin(elapsed * OMEGA);
  for (const handle of handles) {
    world.set(handle, Transform, { pos: [0, y, 0], scale: [s, s, s] });
  }
}
