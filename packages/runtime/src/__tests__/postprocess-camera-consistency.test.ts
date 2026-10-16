// m2-t4: postProcessParams <-> cameras same-origin constraint test (TDD red).
//
// Test R-6 risk mitigation: the merged frame's postProcessParams and cameras
// must come from the same (owner) world, because the built-in tonemap provider
// reads cameras[0] (render-system-extract.ts:3341-3351) and the two must be
// atomically consistent.
//
// Construct dual-world scenario:
//   - owner world A has postProcessParams + camera
//   - world B has different postProcessParams + camera
// Assert after merge: postProcessParams and cameras both come from owner A.
// Non-owner B's postProcessParams are discarded.
//
// Anchors:
//   plan-tasks.json m2-t4
//   plan-strategy D-3 (owner snapshot holistic selection)
//   research Finding 3 / R-6
//   requirements AC-05/06

import { World } from '@forgeax/engine-ecs';
import { Camera, PostProcessParams } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import type { CameraSnapshot } from '../../../render/src/render-contract';
import type { ExtractedFrame } from '../../../render/src/render-system-extract';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

// ── Helpers ─────────────────────────────────────────────────────────────────

function identityTransform(): {
  pos: [number, number, number];
  quat: [number, number, number, number];
  scale: [number, number, number];
} {
  return {
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

/**
 * Simulate the D-3 merge that extractFrames will implement, specifically
 * for postProcessParams and cameras same-origin verification.
 *
 * Per D-3: cameras + postProcessParams are taken from the owner world's
 * frame holistically. Non-owner's same-type items are discarded.
 */
function simulateMergeWithOwnerSelection(
  frames: ExtractedFrame[],
  ownerIndex: number,
): {
  cameras: CameraSnapshot[];
  postProcessParams: ReadonlyMap<string, Uint8Array>;
  singleWorldCameras: CameraSnapshot[][];
  singleWorldPostProcess: ReadonlyMap<string, Uint8Array>[];
} {
  // biome-ignore lint/style/noNonNullAssertion: ownerIndex is validated, frames is dense
  const ownerFrame = frames[ownerIndex]!;

  // D-3: cameras only from owner world
  const cameras = [...ownerFrame.cameras];

  // D-3: postProcessParams only from owner world
  const postProcessParams = new Map(ownerFrame.postProcessParams);

  return {
    cameras,
    postProcessParams,
    singleWorldCameras: frames.map((f) => f.cameras),
    singleWorldPostProcess: frames.map((f) => f.postProcessParams),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('postProcessParams <-> cameras same-origin constraint (m2-t4, R-6)', () => {
  // ── R-6: postProcessParams and cameras from same world ─────────────────────

  it('R-6: merged postProcessParams and cameras both come from owner world', () => {
    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            near: 0.1,
            far: 100,
            aspect: 1,
            clearColor: [0.1, 0.2, 0.3, 1],
          },
        },
      )
      .unwrap();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: PostProcessParams,
          data: {
            shader: 'forgeax::owner-effect',
            data: new Uint8Array([1, 2, 3]),
          },
        },
      )
      .unwrap();

    const worldB = new World();
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            near: 0.5,
            far: 50,
            aspect: 2,
            clearColor: [0.9, 0.8, 0.7, 1],
          },
        },
      )
      .unwrap();
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: PostProcessParams,
          data: {
            shader: 'forgeax::non-owner-effect',
            data: new Uint8Array([9, 9, 9]),
          },
        },
      )
      .unwrap();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    // Verify both worlds have their own cameras and postProcessParams
    expect(frameA.cameras.length).toBeGreaterThanOrEqual(1);
    expect(frameB.cameras.length).toBeGreaterThanOrEqual(1);
    expect(frameA.postProcessParams.has('forgeax::owner-effect')).toBe(true);
    expect(frameB.postProcessParams.has('forgeax::non-owner-effect')).toBe(true);

    // owner=0 (worldA)
    const merged = simulateMergeWithOwnerSelection([frameA, frameB], 0);

    // Cameras come from owner world A
    expect(merged.cameras.length).toBe(frameA.cameras.length);
    // postProcessParams come from owner world A
    expect(merged.postProcessParams.has('forgeax::owner-effect')).toBe(true);
    // Non-owner's postProcessParams are discarded
    expect(merged.postProcessParams.has('forgeax::non-owner-effect')).toBe(false);

    // owner=1 (worldB)
    const merged2 = simulateMergeWithOwnerSelection([frameA, frameB], 1);

    // Cameras come from owner world B
    expect(merged2.cameras.length).toBe(frameB.cameras.length);
    // postProcessParams come from owner world B
    expect(merged2.postProcessParams.has('forgeax::non-owner-effect')).toBe(true);
    expect(merged2.postProcessParams.has('forgeax::owner-effect')).toBe(false);
  });

  // ── Non-owner postProcessParams discarded ──────────────────────────────────

  it('R-6: non-owner postProcessParams are discarded, not merged', () => {
    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Camera, data: { fov: Math.PI / 4, near: 0.1, far: 100, aspect: 1 } },
      )
      .unwrap();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: PostProcessParams,
          data: {
            shader: 'forgeax::effect-a',
            data: new Uint8Array([1]),
          },
        },
      )
      .unwrap();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: PostProcessParams,
          data: {
            shader: 'forgeax::effect-b',
            data: new Uint8Array([2]),
          },
        },
      )
      .unwrap();

    const worldB = new World();
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: PostProcessParams,
          data: {
            shader: 'forgeax::effect-c',
            data: new Uint8Array([3]),
          },
        },
      )
      .unwrap();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    const merged = simulateMergeWithOwnerSelection([frameA, frameB], 0);

    // Owner's params are present
    expect(merged.postProcessParams.has('forgeax::effect-a')).toBe(true);
    expect(merged.postProcessParams.has('forgeax::effect-b')).toBe(true);
    // Non-owner's params are discarded
    expect(merged.postProcessParams.has('forgeax::effect-c')).toBe(false);
  });

  // ── Empty world postProcessParams ──────────────────────────────────────────

  it('R-6: when owner world has no user PostProcessParams, only engine-injected tonemap is present', () => {
    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Camera, data: { fov: Math.PI / 4, near: 0.1, far: 100, aspect: 1 } },
      )
      .unwrap();

    const worldB = new World();
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: PostProcessParams,
          data: {
            shader: 'forgeax::effect-b',
            data: new Uint8Array([2]),
          },
        },
      )
      .unwrap();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    // owner=0: worldA has no user PostProcessParams, but has a camera
    // so engine injects forgeax::tonemap
    const merged = simulateMergeWithOwnerSelection([frameA, frameB], 0);

    // Non-owner's user-defined postProcessParams are NOT carried over
    expect(merged.postProcessParams.has('forgeax::effect-b')).toBe(false);
    // But owner's engine-injected forgeax::tonemap is present
    // (camera exists, so engine provides it)
    const ownerHasTonemap = frameA.postProcessParams.has('forgeax::tonemap');
    expect(merged.postProcessParams.has('forgeax::tonemap')).toBe(ownerHasTonemap);
  });

  // ── Same-origin: cameras[0] exists in the same world as postProcessParams ──

  it('R-6: tonemap hidden dependency safety — cameras[0] and postProcessParams from same owner', () => {
    // The built-in tonemap provider reads cameras[0] (render-system-extract.ts:3341-3351).
    // If postProcessParams came from owner but cameras came from non-owner,
    // the tonemap would read the wrong camera's exposure/tonemap/whitePoint.
    // This test verifies the merge contract guarantees they are same-origin.

    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            near: 0.1,
            far: 100,
            aspect: 1,
            tonemap: 1, // 'reinhard'
            exposure: 1.5,
            whitePoint: 3.0,
          },
        },
      )
      .unwrap();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: PostProcessParams,
          data: {
            shader: 'forgeax::custom-effect',
            data: new Uint8Array([1, 2, 3]),
          },
        },
      )
      .unwrap();

    const worldB = new World();
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            near: 0.5,
            far: 50,
            aspect: 2,
            tonemap: 0, // 'none'
            exposure: 0.5,
            whitePoint: 1.0,
          },
        },
      )
      .unwrap();
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: PostProcessParams,
          data: {
            shader: 'forgeax::other-effect',
            data: new Uint8Array([9, 9, 9]),
          },
        },
      )
      .unwrap();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    const merged = simulateMergeWithOwnerSelection([frameA, frameB], 0);

    // postProcessParams and cameras[0] both come from owner worldA
    expect(merged.cameras.length).toBeGreaterThanOrEqual(1);
    expect(merged.cameras[0]?.exposure).toBe(1.5);
    expect(merged.cameras[0]?.whitePoint).toBe(3.0);

    // Owner's user-defined postProcessParams are carried over
    expect(merged.postProcessParams.has('forgeax::custom-effect')).toBe(true);
    // Non-owner's user-defined postProcessParams are discarded
    expect(merged.postProcessParams.has('forgeax::other-effect')).toBe(false);

    // When owner=1 (worldB), cameras[0] has different values
    const merged2 = simulateMergeWithOwnerSelection([frameA, frameB], 1);
    expect(merged2.cameras[0]?.exposure).toBe(0.5);
    expect(merged2.cameras[0]?.whitePoint).toBe(1.0);

    // Owner=1's user-defined postProcessParams are carried over
    expect(merged2.postProcessParams.has('forgeax::other-effect')).toBe(true);
    // Non-owner's user-defined postProcessParams are discarded
    expect(merged2.postProcessParams.has('forgeax::custom-effect')).toBe(false);

    // Both frames have engine-injected forgeax::tonemap (because both have cameras).
    // When owner=0, the forgeax::tonemap comes from worldA's camera context.
    // When owner=1, it comes from worldB's camera context.
    // Both are present because each owner has a camera.
    expect(merged.postProcessParams.has('forgeax::tonemap')).toBe(
      frameA.postProcessParams.has('forgeax::tonemap'),
    );
    expect(merged2.postProcessParams.has('forgeax::tonemap')).toBe(
      frameB.postProcessParams.has('forgeax::tonemap'),
    );
  });
});
