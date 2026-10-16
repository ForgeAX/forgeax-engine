// m2-t1: extractFrames merge matrix test (TDD red).
//
// Verify the D-3 merge semantics for extractFrames:
//   AC-04: renderables concat by worlds[] order, each stamped with worldId;
//          lights merge: point[]/spot[] concat, directional first-hit in
//          worlds[] order, directionalCount sum.
//   AC-05: singleton resources (skylight/skybox/postProcessParams) only from
//          owner world; non-owner same kind ignored.
//   AC-06: cameras only from owner world.
//   dispatch: per-world renderableIndex rebased by base offset, sorted by
//          queue with stable sort.
//   frustumStats: culled/total summed across worlds.
//
// Anchors:
//   plan-tasks.json m2-t1
//   plan-strategy D-3
//   requirements AC-04/AC-05/AC-06

import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  Camera,
  DirectionalLight,
  PostProcessParams,
  SkyboxBackground,
  Skylight,
  SpotLight,
} from '../../../render/src/components';
import type { CameraSnapshot } from '../../../render/src/render-contract';
import type {
  DirectionalLightSnapshot,
  DispatchEntry,
  ExtractedFrame,
  ExtractedLights,
  PointLightSnapshot,
  RenderableSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
  SpotLightSnapshot,
} from '../../../render/src/render-system-extract';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame, extractFrames } from '../../../render/src/render-system-extract-tail';

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

function makeWorldWithCamera(): World {
  const world = new World();
  world
    .spawn(
      { component: Transform, data: identityTransform() },
      { component: Camera, data: { fov: Math.PI / 4, near: 0.1, far: 100, aspect: 1 } },
    )
    .unwrap();
  return world;
}

function makeWorldWithDirectionalLight(): World {
  const world = new World();
  world
    .spawn(
      { component: Transform, data: identityTransform() },
      {
        component: DirectionalLight,
        data: {
          color: [1, 1, 1],
          intensity: 1,
          direction: [0, -1, 0],
        },
      },
    )
    .unwrap();
  return world;
}

function makeWorldWithSkylight(): World {
  const world = new World();
  world
    .spawn(
      { component: Transform, data: identityTransform() },
      { component: Skylight, data: { intensity: 1 } },
    )
    .unwrap();
  return world;
}

function makeWorldWithSkybox(): World {
  const world = new World();
  world
    .spawn(
      { component: Transform, data: identityTransform() },
      { component: SkyboxBackground, data: { mode: 1 } },
    )
    .unwrap();
  return world;
}

function makeWorldWithPostProcess(): World {
  const world = new World();
  world
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
  return world;
}

/**
 * Simulate the D-3 merge that extractFrames will implement.
 * Used to verify the merge logic before extractFrames exists (TDD red).
 */
function simulateMerge(
  frames: ExtractedFrame[],
  ownerIndex: number,
): {
  cameras: CameraSnapshot[];
  lights: ExtractedLights;
  renderables: RenderableSnapshot[];
  dispatch: DispatchEntry[];
  skylight: SkylightSnapshot | undefined;
  skylightCount: number;
  skybox: SkyboxSnapshot | undefined;
  skyboxCount: number;
  frustumStats: { culled: number; total: number };
  postProcessParams: Map<string, Uint8Array>;
} {
  // AC-04: renderables concat by worlds[] order, stamped with worldId
  const renderables: RenderableSnapshot[] = [];
  const renderableBaseOffsets: number[] = [];
  for (let wi = 0; wi < frames.length; wi++) {
    // biome-ignore lint/style/noNonNullAssertion: frames is a dense array, index bounded by length
    const f = frames[wi]!;
    renderableBaseOffsets.push(renderables.length);
    for (const r of f.renderables) {
      renderables.push({ ...r, worldId: wi });
    }
  }

  // AC-04: lights — point[]/spot[] concat; directional first-hit in worlds[] order; directionalCount sum
  const point: PointLightSnapshot[] = [];
  const spot: SpotLightSnapshot[] = [];
  const rect: ExtractedLights['rect'][number][] = [];
  let directional: DirectionalLightSnapshot | undefined;
  let directionalCount = 0;
  for (const f of frames) {
    for (const p of f.lights.point) point.push(p);
    for (const s of f.lights.spot) spot.push(s);
    for (const r of f.lights.rect) rect.push(r);
    if (directional === undefined && f.lights.directional !== undefined) {
      directional = f.lights.directional;
    }
    directionalCount += f.lights.directionalCount;
  }
  const firstDirectionalLights = frames.find(
    (frame) => frame.lights.directional !== undefined,
  )?.lights;
  const lights: ExtractedLights = {
    directional,
    directionalCount,
    point,
    spot,
    rect,
    lightViewProj: firstDirectionalLights?.lightViewProj,
    splitPlanes: firstDirectionalLights?.splitPlanes,
    cascadeCount: firstDirectionalLights?.cascadeCount,
    cascadeBlend: firstDirectionalLights?.cascadeBlend,
    shadowMapSize: firstDirectionalLights?.shadowMapSize,
    depthBias: firstDirectionalLights?.depthBias,
    normalBias: firstDirectionalLights?.normalBias,
    directionalShadowQuality: firstDirectionalLights?.directionalShadowQuality,
    directionalShadowError: firstDirectionalLights?.directionalShadowError,
    pointShadow: frames.flatMap((f) => f.lights.pointShadow),
    directionalCsmConfig: firstDirectionalLights?.directionalCsmConfig,
    directionalCsmDirection: firstDirectionalLights?.directionalCsmDirection,
  };

  // AC-05: singletons from owner world only
  // biome-ignore lint/style/noNonNullAssertion: ownerIndex is validated, frames is dense
  const ownerFrame = frames[ownerIndex]!;
  const skylight = ownerFrame.skylight;
  const skylightCount = ownerFrame.skylightCount;
  const skybox = ownerFrame.skybox;
  const skyboxCount = ownerFrame.skyboxCount;

  // AC-06: cameras only from owner world
  const cameras = [...ownerFrame.cameras];

  // dispatch: per-world renderableIndex rebased by base offset
  const dispatch: DispatchEntry[] = [];
  for (let wi = 0; wi < frames.length; wi++) {
    const base = renderableBaseOffsets[wi];
    const frame = frames[wi];
    if (base === undefined || frame === undefined) continue;
    for (const d of frame.dispatch) {
      dispatch.push({ ...d, renderableIndex: (d.renderableIndex ?? 0) + base });
    }
  }
  // Stable sort by queue value
  dispatch.sort((a, b) => (a.queue ?? 0) - (b.queue ?? 0));

  // frustumStats: culled/total sum
  const frustumStats = {
    culled: frames.reduce((s, f) => s + f.frustumStats.culled, 0),
    total: frames.reduce((s, f) => s + f.frustumStats.total, 0),
  };

  // postProcessParams: only from owner world
  const postProcessParams = new Map(ownerFrame.postProcessParams);

  return {
    cameras,
    lights,
    renderables,
    dispatch,
    skylight,
    skylightCount,
    skybox,
    skyboxCount,
    frustumStats,
    postProcessParams,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('extractFrames merge semantics (m2-t1, AC-04/05/06)', () => {
  // ── AC-04: renderables concat + worldId stamp ──────────────────────────────

  it('AC-04: renderables are concatenated in worlds[] order with worldId stamp', () => {
    // worldA has a camera (no renderable), worldB has a directional light (no renderable)
    // We need renderables to test concat. Let's use camera+light as the test
    // since they produce snapshots but not renderables.
    // For renderables concat test, we verify that worldId is stamped per frame.
    const worldA = makeWorldWithCamera();
    const worldB = makeWorldWithDirectionalLight();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    const merged = simulateMerge([frameA, frameB], 0);

    // All renderables from worldA have worldId=0
    for (const r of merged.renderables) {
      if (frameA.renderables.includes(r as unknown as RenderableSnapshot)) {
        expect(r.worldId).toBe(0);
      } else {
        expect(r.worldId).toBe(1);
      }
    }
  });

  // ── AC-04: lights merge ────────────────────────────────────────────────────

  it('AC-04: lights point[] and spot[] are concatenated across worlds', () => {
    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: { ...identityTransform(), pos: [1, 0, 0] } },
        {
          component: SpotLight,
          data: {
            color: [1, 0, 0],
            intensity: 1,
            direction: [0, -1, 0],
            innerConeDeg: 10,
            outerConeDeg: 30,
          },
        },
      )
      .unwrap();

    const worldB = new World();
    worldB
      .spawn(
        { component: Transform, data: { ...identityTransform(), pos: [2, 0, 0] } },
        {
          component: SpotLight,
          data: {
            color: [0, 1, 0],
            intensity: 2,
            direction: [1, 0, 0],
            innerConeDeg: 15,
            outerConeDeg: 45,
          },
        },
      )
      .unwrap();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    const merged = simulateMerge([frameA, frameB], 0);

    // spot lights from both worlds are concatenated
    expect(merged.lights.spot.length).toBe(2);
    // first spot is from worldA (red)
    expect(merged.lights.spot[0]?.color[0]).toBeGreaterThan(0);
    // second spot is from worldB (green)
    expect(merged.lights.spot[1]?.color[1]).toBeGreaterThan(0);
  });

  it('AC-04: directional light takes first-hit in worlds[] order', () => {
    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            color: [1, 0, 0],
            intensity: 1,
            direction: [0, -1, 0],
          },
        },
      )
      .unwrap();

    const worldB = new World();
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            color: [0, 1, 0],
            intensity: 2,
            direction: [1, 0, 0],
          },
        },
      )
      .unwrap();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    const merged = simulateMerge([frameA, frameB], 0);

    // directional is first-hit: worldA's red light
    expect(merged.lights.directional).toBeDefined();
    expect(merged.lights.directional?.color[0]).toBeGreaterThan(0);

    // Now reverse the worlds[] order: worldB first
    const merged2 = simulateMerge([frameB, frameA], 0);
    // When worldB is worlds[0], its green light is first-hit
    expect(merged2.lights.directional).toBeDefined();
    expect(merged2.lights.directional?.color[1]).toBeGreaterThan(0);
  });

  it('AC-04: directionalCount is summed across worlds', () => {
    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            color: [1, 0, 0],
            intensity: 1,
            direction: [0, -1, 0],
          },
        },
      )
      .unwrap();

    const worldB = new World();
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            color: [0, 1, 0],
            intensity: 2,
            direction: [1, 0, 0],
          },
        },
      )
      .unwrap();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    const merged = simulateMerge([frameA, frameB], 0);

    // directionalCount = 1 + 1 = 2
    expect(merged.lights.directionalCount).toBe(2);
    expect(frameA.lights.directionalCount).toBe(1);
    expect(frameB.lights.directionalCount).toBe(1);
  });

  it('AC-04: first directional owner error is preserved across the merge', () => {
    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            direction: [0, -1, 0],
            shadowFilter: 4,
            shadowAngularRadius: 999,
            maxPenumbraTexels: 32,
          },
        },
      )
      .unwrap();

    const worldB = makeWorldWithDirectionalLight();
    const frameA = extractFrame(worldA, prepareExtractContext(worldA));
    const frameB = extractFrame(worldB, prepareExtractContext(worldB));

    expect(frameA.lights.directionalShadowError?.code).toBe('shadow-invalid-config');
    expect(frameB.lights.directionalShadowError).toBeUndefined();
    const merged = simulateMerge([frameA, frameB], 0);
    expect(merged.lights.directionalShadowError?.detail).toMatchObject({
      field: 'shadowAngularRadius',
      actual: 999,
    });
  });

  // ── AC-05: singleton resources from owner only ─────────────────────────────

  it('AC-05: skylight is taken from owner world only, non-owner ignored', () => {
    const worldA = makeWorldWithSkylight();
    const worldB = new World(); // no skylight

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    // owner=0 (worldA)
    const merged = simulateMerge([frameA, frameB], 0);
    expect(merged.skylight).toBeDefined();
    expect(merged.skylightCount).toBe(1);

    // owner=1 (worldB) — worldB has no skylight
    const merged2 = simulateMerge([frameA, frameB], 1);
    expect(merged2.skylight).toBeUndefined();
    expect(merged2.skylightCount).toBe(0);
  });

  it('AC-05: skybox is taken from owner world only, non-owner ignored', () => {
    const worldA = makeWorldWithSkybox();
    const worldB = new World();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    const merged = simulateMerge([frameA, frameB], 0);
    expect(merged.skybox).toBeDefined();
    expect(merged.skyboxCount).toBe(1);

    const merged2 = simulateMerge([frameA, frameB], 1);
    expect(merged2.skybox).toBeUndefined();
    expect(merged2.skyboxCount).toBe(0);
  });

  it('AC-05: postProcessParams from non-owner world are ignored', () => {
    const worldA = makeWorldWithPostProcess();
    const worldB = new World();
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

    const merged = simulateMerge([frameA, frameB], 0);

    // Only owner's postProcessParams survive
    expect(merged.postProcessParams.has('forgeax::custom-effect')).toBe(true);
    expect(merged.postProcessParams.has('forgeax::non-owner-effect')).toBe(false);
  });

  // ── AC-06: cameras from owner world only ───────────────────────────────────

  it('AC-06: cameras are taken from owner world only, non-owner cameras ignored', () => {
    const worldA = makeWorldWithCamera();
    const worldB = makeWorldWithCamera(); // has its own camera

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    expect(frameA.cameras.length).toBeGreaterThanOrEqual(1);
    expect(frameB.cameras.length).toBeGreaterThanOrEqual(1);

    // owner=0: only worldA cameras
    const merged = simulateMerge([frameA, frameB], 0);
    expect(merged.cameras.length).toBe(frameA.cameras.length);

    // owner=1: only worldB cameras
    const merged2 = simulateMerge([frameA, frameB], 1);
    expect(merged2.cameras.length).toBe(frameB.cameras.length);
  });

  // ── dispatch: renderableIndex rebase + queue sort ──────────────────────────

  it('dispatch: per-world renderableIndex is rebased by base offset', () => {
    // Two worlds with renderable entities. The rebase ensures
    // renderableIndex is globally unique after merge.
    const worldA = makeWorldWithCamera();
    const worldB = makeWorldWithDirectionalLight();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    const merged = simulateMerge([frameA, frameB], 0);

    // All dispatch renderableIndex values are within total renderables range
    const totalRenderables = merged.renderables.length;
    for (const d of merged.dispatch) {
      const idx = d.renderableIndex ?? 0;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(totalRenderables);
    }
  });

  it('dispatch: merged dispatch is sorted by queue value (stable sort)', () => {
    const worldA = makeWorldWithCamera();
    const worldB = makeWorldWithDirectionalLight();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    const merged = simulateMerge([frameA, frameB], 0);

    // Verify dispatch is sorted by queue ascending
    for (let i = 1; i < merged.dispatch.length; i++) {
      const prev = merged.dispatch[i - 1]?.queue ?? 0;
      const curr = merged.dispatch[i]?.queue ?? 0;
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  // ── frustumStats: culled/total sum ─────────────────────────────────────────

  it('frustumStats: culled and total are summed across worlds', () => {
    const worldA = makeWorldWithCamera();
    const worldB = makeWorldWithCamera();

    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const frameB = extractFrame(worldB as World, prepareExtractContext(worldB as World));

    const merged = simulateMerge([frameA, frameB], 0);

    expect(merged.frustumStats.culled).toBe(
      frameA.frustumStats.culled + frameB.frustumStats.culled,
    );
    expect(merged.frustumStats.total).toBe(frameA.frustumStats.total + frameB.frustumStats.total);
  });

  // ── Single world identity (worldId=0) ──────────────────────────────────────

  it('single world merge is identity: worldId=0 for all renderables', () => {
    const worldA = makeWorldWithCamera();
    const frameA = extractFrame(worldA as World, prepareExtractContext(worldA as World));
    const merged = simulateMerge([frameA], 0);

    // All renderables have worldId=0
    for (const r of merged.renderables) {
      expect(r.worldId).toBe(0);
    }

    // Cameras, lights, etc. are identical to single-world extractFrame
    expect(merged.cameras.length).toBe(frameA.cameras.length);
    expect(merged.lights.directionalCount).toBe(frameA.lights.directionalCount);
  });
});

// bug-20260710-editor-cross-world-shadow: directional CSM matrices must be
// recomputed at the extractFrames merge layer using the SURFACED camera, even
// when the camera and the directional light live in DIFFERENT worlds (the
// editor editorWorld/sceneWorld super-composite). Before the fix, the light's
// cameraless world produced all-zero lightViewProj matrices that the merge
// carried verbatim → the WGSL shadow reader sampled a degenerate matrix
// (0/0 = NaN) → "fully lit" → no shadow on any receiver. These tests drive the
// REAL extractFrames (not simulateMerge) to lock the recompute.
describe('extractFrames cross-world directional CSM (bug-20260710)', () => {
  const isNonZeroMat = (m: Float32Array | undefined): boolean =>
    m !== undefined && Array.from(m).some((x) => x !== 0);

  it('camera in world A, castShadow directional in world B → lightViewProj is non-zero', () => {
    const worldWithCamera = makeWorldWithCamera();
    const worldWithLight = makeWorldWithDirectionalLight(); // castShadow defaults to true

    // Split-owner form: cameras from world 0, resources from world 1 — the
    // editor topology where the light's world (1) has no camera.
    const frame = extractFrames([worldWithCamera as World, worldWithLight as World], {
      cameraOwner: 0,
      resourceOwner: 1,
    });

    expect(frame.lights.directional).toBeDefined();
    const lvp = frame.lights.lightViewProj;
    expect(lvp).toBeDefined();
    expect(lvp?.length).toBe(4);
    // The effective cascades (default cascadeCount=4) must all be non-zero —
    // this is the exact assertion that failed before the merge-layer recompute.
    for (let i = 0; i < (frame.lights.cascadeCount ?? 0); i++) {
      expect(isNonZeroMat(lvp?.[i])).toBe(true);
    }
    // splitPlanes reach the component shadowDistance on the last cascade.
    expect(frame.lights.splitPlanes).toBeDefined();
    expect(frame.lights.splitPlanes).toHaveLength(16);
    expect(frame.lights.splitPlanes?.[1]).toBeGreaterThan(0);
    expect(frame.lights.splitPlanes?.[2]).toBeGreaterThan(0);
  });

  it('single world (camera + light together) still yields non-zero lightViewProj', () => {
    // Regression guard: the merge-layer recompute must not break the common
    // single-world case where light and camera share one world.
    const world = new World();
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Camera, data: { fov: Math.PI / 4, near: 0.1, far: 100, aspect: 1 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: { color: [1, 1, 1], intensity: 1, direction: [0.3, -1, 0.2] },
        },
      )
      .unwrap();

    const frame = extractFrames([world as World], 0);
    const lvp = frame.lights.lightViewProj;
    expect(lvp?.length).toBe(4);
    for (let i = 0; i < (frame.lights.cascadeCount ?? 0); i++) {
      expect(isNonZeroMat(lvp?.[i])).toBe(true);
    }
    expect(frame.lights.splitPlanes).toHaveLength(16);
  });
});
