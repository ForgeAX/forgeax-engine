// feat-20260709-editor-world-partition-editorworld-super-composite / M1 / w1
// (RED — impl lands in w4/w5/w6). Contract test for the camera-owner /
// resource-owner split of the extract stage.
//
// Today `extractFrames(worlds, owner)` takes a SINGLE owner index: cameras +
// singleton render resources (skylight / skybox / postProcessParams) all come
// from `worlds[owner]` (render-system-extract.ts:1671-1676). This feature
// splits that single index into two independent indices:
//
//   - `cameraOwner`   — the world whose cameras are surfaced.
//   - `resourceOwner` — the world whose skylight / skybox / postProcessParams
//                       are surfaced.
//
// This test pins the FUTURE contract as the SSOT the w4-w6 implementation must
// satisfy: `extractFrames(worlds, { cameraOwner, resourceOwner })`. It calls
// that two-index form directly. Until w4 changes the signature, the call is a
// compile/type mismatch and this file is RED — exactly the TDD red window
// (test-first). Once w4 lands the `{ cameraOwner, resourceOwner }` object
// parameter these assertions turn green with no edits here.
//
// rhi-null headless: extractFrames is a pure world->snapshot merge that needs
// no GPU (no AssetRegistry, no pipelineState). It runs in the node vitest
// project (no dawn / no browser).
//
// Anchors:
//   requirements AC-08 (owner split delivered; contract covers "camera from A
//     world, singleton resources from B world")
//   research F2 (extract:1671-1676 cameras + skylight/skybox/postProcess read
//     the same ownerFrame — the split point)
//   plan-strategy §2 D-3 (explicit `{ cameraOwner, resourceOwner }` required
//     indices) + §5.3 key test point + §3.3 interface example

import { World } from '@forgeax/engine-ecs';
import { Camera, Skylight } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { extractFrames } from '../../../render/src/render-system-extract-tail';

// The two-index owner shape w4-w6 will introduce. Declared locally so this
// test states the contract independent of the (not-yet-updated) source type.
interface OwnerSplit {
  readonly cameraOwner: number;
  readonly resourceOwner: number;
}

// `extractFrames` currently is `(worlds, owner: number, ...)`. The future
// contract is `(worlds, opts: { cameraOwner, resourceOwner }, ...)`. We reach
// the future signature through a typed alias so the intent reads clearly; the
// call is what turns green once w4 changes the real signature.
type ExtractFramesOwnerSplit = (
  worlds: readonly World[],
  owner: OwnerSplit,
) => ReturnType<typeof extractFrames>;

const extractFramesSplit = extractFrames as unknown as ExtractFramesOwnerSplit;

function identityTransform(): {
  pos: number[];
  quat: number[];
  scale: number[];
} {
  return { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] };
}

// World A: carries a camera with a DISTINGUISHING far plane so we can prove the
// surfaced camera came from A (not B). No skylight.
const CAMERA_A_FAR = 777;

function makeCameraWorld(far: number): World {
  const world = new World();
  world
    .spawn(
      { component: Transform, data: identityTransform() },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far } },
    )
    .unwrap();
  return world;
}

// World B: carries a skylight with a DISTINGUISHING intensity so we can prove
// the surfaced skylight came from B (not A). No camera.
const SKYLIGHT_B_INTENSITY = 0.375;

function makeResourceWorld(intensity: number): World {
  const world = new World();
  world
    .spawn(
      { component: Transform, data: identityTransform() },
      { component: Skylight, data: { intensity } },
    )
    .unwrap();
  return world;
}

describe('extractFrames camera-owner / resource-owner split contract (w1, AC-08)', () => {
  // ── Combination 1: camera from A world, singleton resource from B world ──
  it('cameraOwner=0 / resourceOwner=1: cameras come from world A, skylight from world B', () => {
    const worldA = makeCameraWorld(CAMERA_A_FAR); // camera, no skylight
    const worldB = makeResourceWorld(SKYLIGHT_B_INTENSITY); // skylight, no camera

    const frame = extractFramesSplit([worldA, worldB], { cameraOwner: 0, resourceOwner: 1 });

    // Camera is surfaced from A (cameraOwner=0) — recognisable by its far plane.
    expect(frame.cameras.length).toBe(1);
    expect(frame.cameras[0]?.far).toBe(CAMERA_A_FAR);

    // Skylight is surfaced from B (resourceOwner=1) — recognisable by intensity.
    // If skylight were (wrongly) read from cameraOwner world A, it would be
    // undefined (A has no skylight), so this assertion has discriminating power.
    expect(frame.skylight).toBeDefined();
    expect(frame.skylight?.intensity).toBeCloseTo(SKYLIGHT_B_INTENSITY);
    expect(frame.skylightCount).toBe(1);
  });

  // ── Combination 2: same world is both owners (degenerate — old owner semantics) ──
  it('cameraOwner=resourceOwner=0 is byte-equivalent to the legacy single owner=0', () => {
    // One world that carries BOTH a camera and a skylight.
    const world = new World();
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: CAMERA_A_FAR } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Skylight, data: { intensity: SKYLIGHT_B_INTENSITY } },
      )
      .unwrap();

    // A second world with a DIFFERENT camera + skylight that must NOT leak in
    // when both owners point at index 0.
    const other = new World();
    other
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 2, near: 0.5, far: 12 } },
      )
      .unwrap();
    other
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Skylight, data: { intensity: 0.9 } },
      )
      .unwrap();

    const frame = extractFramesSplit([world, other], { cameraOwner: 0, resourceOwner: 0 });

    // Both camera and singleton resource resolve from world 0 only.
    expect(frame.cameras.length).toBe(1);
    expect(frame.cameras[0]?.far).toBe(CAMERA_A_FAR);
    expect(frame.skylight?.intensity).toBeCloseTo(SKYLIGHT_B_INTENSITY);
    // skylightCount reports the OWNER (resource) world's live skylight count,
    // not the other world's — proves no cross-world leak in the degenerate case.
    expect(frame.skylightCount).toBe(1);
  });

  // ── Combination 3: owners swapped — camera from B, resource from A ──
  it('cameraOwner=1 / resourceOwner=0: cameras come from world B, skylight from world A', () => {
    // world0 = resource world (skylight, no camera); world1 = camera world.
    const world0 = makeResourceWorld(SKYLIGHT_B_INTENSITY); // resourceOwner target
    const world1 = makeCameraWorld(CAMERA_A_FAR); // cameraOwner target

    const frame = extractFramesSplit([world0, world1], { cameraOwner: 1, resourceOwner: 0 });

    // Camera surfaced from world1 (cameraOwner=1).
    expect(frame.cameras.length).toBe(1);
    expect(frame.cameras[0]?.far).toBe(CAMERA_A_FAR);

    // Skylight surfaced from world0 (resourceOwner=0). If the code read skylight
    // from cameraOwner (world1, no skylight) this would be undefined — so the
    // swap direction is genuinely exercised.
    expect(frame.skylight).toBeDefined();
    expect(frame.skylight?.intensity).toBeCloseTo(SKYLIGHT_B_INTENSITY);
    expect(frame.skylightCount).toBe(1);
  });
});
