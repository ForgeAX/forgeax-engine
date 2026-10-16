// feat-20260709 M3 / w13: AC-11 Camera clear path -- CameraSnapshot.clearColor
// structural change (D-3).
//
// The clear-color quartet on CameraSnapshot collapses from 4 scalars
// (clearR/G/B/A) to a single `clearColor` field, aligned with the light
// snapshot shape. This test asserts the extract -> snapshot -> clear-consumer
// value is byte-equal to what the authored Camera SoA column carries, AND that
// the zero-Camera fallback snapshot paints [0,0,0,1] (frame-snapshot.ts). This
// is the AC-11 Camera path (q5), independent of the M2 light GPU byte-neutral
// path.
//
// TDD note: this test asserts the NEW `cam.clearColor` snapshot shape and stays
// red until w14 lands the CameraSnapshot collapse (plan-strategy §5.1
// mixed-TDD form).

import { World } from '@forgeax/engine-ecs';
import { Camera } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  makeZeroCameraFallbackSnapshot,
  ZERO_CAMERA_CLEAR_FALLBACK,
} from '../../../render/src/record/frame-snapshot';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

function spawnCameraWithClear(world: World, clear: readonly [number, number, number, number]) {
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      {
        component: Camera,
        data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100, clearColor: clear },
      },
    )
    .unwrap();
}

describe('w13 -- CameraSnapshot.clearColor equivalence + fallback (AC-11 / D-3)', () => {
  it('extract surfaces clearColor byte-equal to the authored Camera SoA column', () => {
    const authored: [number, number, number, number] = [0.25, 0.5, 0.75, 1.0];
    const world = new World();
    spawnCameraWithClear(world, authored);
    propagateTransforms(world);
    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.cameras.length).toBe(1);
    const cam = frame.cameras[0];
    expect(cam).toBeDefined();
    if (!cam) return;
    // f32 storage rounds each channel; compare against the same rounding the
    // pre-collapse 4-scalar path produced (each channel was an f32 column).
    expect(Array.from(cam.clearColor)).toEqual(authored.map((v) => Math.fround(v)));
  });

  it('Camera spawned without clearColor defaults to transparent black [0,0,0,0] on the snapshot', () => {
    const world = new World();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    propagateTransforms(world);
    const frame = extractFrame(world, prepareExtractContext(world));
    const cam = frame.cameras[0];
    expect(cam).toBeDefined();
    if (!cam) return;
    expect(Array.from(cam.clearColor)).toEqual([0, 0, 0, 0]);
  });

  it('zero-Camera fallback snapshot carries clearColor = [0,0,0,1] (frame-snapshot.ts)', () => {
    const snap = makeZeroCameraFallbackSnapshot();
    expect(Array.from(snap.clearColor)).toEqual([0, 0, 0, 1]);
    expect(Array.from(snap.clearColor)).toEqual(Array.from(ZERO_CAMERA_CLEAR_FALLBACK));
  });
});
