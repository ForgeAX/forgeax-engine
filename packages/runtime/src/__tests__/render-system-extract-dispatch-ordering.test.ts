// bug-20260709-builtin-quad-withoutaabb-disables-sprite-frustum-cu M2 / AC-06.
//
// Regression lock for the M2.5 `pendingDispatch` + `flushPendingDispatch`
// pairing that ships with the Stage 1 aabb restore. After M1 restored
// HANDLE_QUAD's local-space aabb, builtin quads enter the frustum-cull
// three-gate branch at `render-system-extract.ts` like any user asset.
// Before M2.5 the three `dispatch.push` sites ran BEFORE the cull `continue`
// so a culled entity left dangling dispatch entries whose `renderableIndex`
// aliased the slot a LATER visible entity's renderable occupied. The record
// stage then read the wrong `materialHandle` and picked the wrong pipeline
// layout — the `pbr-mesh-array-bgl` (URP) vs `hdrp-unified-bgl-group2` (HDRP)
// mismatch that showed up 168x on PR #598 CI's deferred-shading smoke.
//
// M2.5 stages each entity's dispatch entries into a per-entity
// `pendingDispatch` array, then flushes them into the shared `dispatch[]`
// only at the three renderable-push sites (all inside the cull-passed
// branch). A culled entity `continue`s without flushing, so its pending
// entries are naturally discarded. Each pending entry captures the current
// `renderables.length`; no other entity can push before this entity survives
// culling and takes that slot, so flush can publish the original entry without
// allocating a second descriptor.
//
// Coverage matrix — this file exercises every push × flush combination the
// runtime unit-test surface can reach:
//
//   push A: resolved-material matched-passes loop      (extract.ts ~L3125)
//   push B: default-material shadow-caster pass         (extract.ts ~L3176)
//   push C: default-material forward pass               (extract.ts ~L3194)
//   flush 1: hasInstances && instRes not-ok             (extract.ts ~L3522)
//   flush 2: hasInstances && instRes ok                 (extract.ts ~L3537)
//   flush 3: !hasInstances (plain single entity)        (extract.ts ~L3551)
//
//   test 1  — push A + flush 3     (main branch, non-instances)
//   test 2  — push B + push C + flush 3  (default material, non-instances)
//   test 3  — push A + flush 2     (main branch, instances-success)
//   test 4  — push A + flush 3     (all-culled scene: zero dispatch)
//
// Flush site 1 (hasInstances && !instRes.ok) is unreachable from a healthy
// spawn — the Instances archetype bundle key implies the component row is
// live. It shares the exact `renderables.push({ ...baseRenderable, entityKey })`
// shape with flush 3 by mechanical inspection (extract.ts L3521-3523 vs
// L3550-3552); no unit-test path drives it without mocking World internals,
// so it is covered by the shared-shape argument, not by a separate case.
//
// Topology-only assertions: this file checks dispatch/renderable slot
// alignment (`renderableIndex < renderables.length`, count parity, per-entry
// paramSnapshot equality with the target renderable). It does NOT assert
// record-stage material handle re-resolution or GPU behaviour — those
// cross-stage checks live in the hello-shadow-opt-out / deferred-shading
// dawn smokes (per plan-strategy §5.5).

import { AssetRegistry, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, Instances, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function identityTransform() {
  return {
    pos: [0, 0, 0] as [number, number, number],
    quat: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

// Helper for `{...identityTransform(), posZ: N}` migration — build a fresh pos
// vec with only Z overridden (PR #656 array-schema requires atomic pos writes).
function transformAtZ(z: number) {
  return {
    pos: [0, 0, z] as [number, number, number],
    quat: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

function perspectiveCameraData() {
  return {
    fov: Math.PI / 4,
    aspect: 1,
    near: 0.1,
    far: 100,
    projection: 0,
    left: -1,
    right: 1,
    bottom: -1,
    top: 1,
  };
}

function spawnFrontFacingCamera(world: World): void {
  // Camera at posZ=5 looking down -Z (default). With far=100 the far plane
  // sits near posZ=-95; an entity at posZ=100 is behind the camera and
  // outside the frustum, so its aabb-carrying renderable is culled.
  world
    .spawn(
      { component: Transform, data: transformAtZ(5) },
      { component: Camera, data: perspectiveCameraData() },
    )
    .unwrap();
}

function registerUnlitMaterial(world: World, rgb: readonly [number, number, number]) {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [rgb[0], rgb[1], rgb[2]] },
  });
}

function expectSlotAlignment(
  frame: ReturnType<typeof extractFrame>,
  { requireBaseColorEquality }: { requireBaseColorEquality: boolean },
): void {
  // Every dispatch entry's renderableIndex must land inside [0, renderables.length).
  for (const de of frame.dispatch) {
    expect(de.renderableIndex).toBeGreaterThanOrEqual(0);
    expect(de.renderableIndex).toBeLessThan(frame.renderables.length);
    const target = frame.renderables[de.renderableIndex];
    expect(target).toBeDefined();
    if (requireBaseColorEquality) {
      // paramSnapshot.baseColor is the closest AI-user-observable proxy for
      // "does this dispatch entry belong to this renderable" without crossing
      // into the record stage's materialHandle resolution.
      const deColor = (de.paramSnapshot?.baseColor ?? []) as readonly number[];
      const targetColor = (target?.material.paramSnapshot?.baseColor ?? []) as readonly number[];
      expect(deColor).toEqual(targetColor);
    }
  }
}

describe('render-system-extract M2.5 dispatch/renderable slot pairing (AC-06)', () => {
  it("push A + flush 3 (resolved material, non-instances): culled entity does not alias the surviving entity's renderable slot", () => {
    // Scenario mirrors the PR #598 CI failure signature: entity B (culled)
    // is spawned FIRST so pre-M2.5 its dispatch push would capture
    // renderableIndex = 0; entity A (visible) is spawned second and its
    // renderable pushes into slot 0. Distinct materials make the aliasing
    // observable via paramSnapshot.baseColor equality.
    const world = new World();
    const assets = new AssetRegistry(makeMockShaderRegistry());
    spawnFrontFacingCamera(world);

    const matGreen = registerUnlitMaterial(world, [0, 1, 0]);
    const matRed = registerUnlitMaterial(world, [1, 0, 0]);

    world
      .spawn(
        { component: Transform, data: transformAtZ(100) },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [matGreen] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [matRed] } },
      )
      .unwrap();

    expect(propagateTransforms(world).ok).toBe(true);
    const frame = extractFrame(world, prepareExtractContext(world, { assets }));

    expect(frame.renderables).toHaveLength(1);
    // One matched Forward pass per surviving entity — pre-M2.5 this would be 2
    // (the culled green entity's dispatch push at push-site A already ran).
    expect(frame.dispatch).toHaveLength(1);
    expect(frame.dispatch[0]?.renderableIndex).toBe(0);
    expect(frame.dispatch[0]?.tags).toEqual({ LightMode: 'Forward' });
    expect(frame.dispatch[0]?.renderState).toBeUndefined();
    expect(frame.renderables[0]?.material.renderState).toBeUndefined();
    expectSlotAlignment(frame, { requireBaseColorEquality: true });
    // Frustum-stat sanity: cull loop actually ran (Stage 1 aabb restore).
    expect(frame.frustumStats.total).toBeGreaterThanOrEqual(2);
    expect(frame.frustumStats.culled).toBeGreaterThanOrEqual(1);
  });

  it('push B + push C + flush 3 (default material shadow+forward, non-instances): culled entity leaves no dangling dispatch', () => {
    // MeshRenderer without a materials array drives handleRaw===0 which
    // fires the default-material two-push block (shadow-caster + forward)
    // at push-sites B and C. plan-strategy §D-7 explicitly names this branch
    // as part of the M2.5 fix scope (shadow-opt-out AC-13 depends on it).
    const world = new World();
    spawnFrontFacingCamera(world);

    world
      .spawn(
        { component: Transform, data: transformAtZ(100) },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: {} as never },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: {} as never },
      )
      .unwrap();

    expect(propagateTransforms(world).ok).toBe(true);
    const frame = extractFrame(world, prepareExtractContext(world));

    expect(frame.renderables).toHaveLength(1);
    // Two entries per surviving entity (shadow-caster + forward) — pre-M2.5
    // this would be 4 because both entities pushed the pair before cull.
    expect(frame.dispatch).toHaveLength(2);
    // Both entries point at the single surviving renderable's slot.
    for (const de of frame.dispatch) {
      expect(de.renderableIndex).toBe(0);
    }
    // Both LightMode tags present (shadow + forward) — confirms push B and
    // push C both flushed through the same flush site (flush 3).
    const lightModes = frame.dispatch.map((de) => de.tags.LightMode).sort();
    expect(lightModes).toEqual(['Forward', 'ShadowCaster']);
    expectSlotAlignment(frame, { requireBaseColorEquality: false });
  });

  it('push A + flush 2 (resolved material, instances-success): culled instances entity does not leave dangling dispatch', () => {
    // Instances component drives the hasInstances && instRes.ok branch
    // (flush site 2). Frustum cull still operates on the entity's own
    // Transform + local aabb (pre-instance transforms), so an Instances
    // entity at posZ=100 is culled the same way a plain entity is.
    const world = new World();
    const assets = new AssetRegistry(makeMockShaderRegistry());
    spawnFrontFacingCamera(world);

    const matBlue = registerUnlitMaterial(world, [0, 0, 1]);
    const matYellow = registerUnlitMaterial(world, [1, 1, 0]);

    // 4 instances, identity mat4 columns each (16 floats per instance).
    const instanceTransforms = new Float32Array(4 * 16);
    for (let n = 0; n < 4; n++) {
      // col-major identity
      instanceTransforms[n * 16 + 0] = 1;
      instanceTransforms[n * 16 + 5] = 1;
      instanceTransforms[n * 16 + 10] = 1;
      instanceTransforms[n * 16 + 15] = 1;
    }

    world
      .spawn(
        { component: Transform, data: transformAtZ(100) },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [matBlue] } },
        { component: Instances, data: { transforms: instanceTransforms } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [matYellow] } },
        { component: Instances, data: { transforms: instanceTransforms } },
      )
      .unwrap();

    expect(propagateTransforms(world).ok).toBe(true);
    const frame = extractFrame(world, prepareExtractContext(world, { assets }));

    expect(frame.renderables).toHaveLength(1);
    expect(frame.renderables[0]?.instances).toBeDefined();
    expect(frame.renderables[0]?.instances?.instanceCount).toBe(4);
    // One resolved-material Forward pass per surviving instances entity.
    expect(frame.dispatch).toHaveLength(1);
    expect(frame.dispatch[0]?.renderableIndex).toBe(0);
    expectSlotAlignment(frame, { requireBaseColorEquality: true });
  });

  it('push A + flush 3 negative path (all HANDLE_QUAD entities out of view): zero renderables and zero dispatch', () => {
    // Edge case from requirements §edge-cases row 4: with all HANDLE_QUAD
    // entities off-frustum, `renderables` and `dispatch` both empty; the
    // per-entity `pendingDispatch` is dropped on every cull `continue` so
    // no dangling entries leak into the shared `dispatch[]`.
    const world = new World();
    const assets = new AssetRegistry(makeMockShaderRegistry());
    spawnFrontFacingCamera(world);

    const matGrey = registerUnlitMaterial(world, [0.5, 0.5, 0.5]);
    for (let n = 0; n < 3; n++) {
      world
        .spawn(
          { component: Transform, data: transformAtZ(100 + n) },
          { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
          { component: MeshRenderer, data: { materials: [matGrey] } },
        )
        .unwrap();
    }

    expect(propagateTransforms(world).ok).toBe(true);
    const frame = extractFrame(world, prepareExtractContext(world, { assets }));

    expect(frame.renderables).toHaveLength(0);
    expect(frame.dispatch).toHaveLength(0);
    // Cull loop actually visited each entity (Stage 1 aabb restore held).
    expect(frame.frustumStats.total).toBeGreaterThanOrEqual(3);
    expect(frame.frustumStats.culled).toBe(frame.frustumStats.total);
  });
});
