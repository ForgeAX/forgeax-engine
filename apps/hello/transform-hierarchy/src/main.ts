import { Update, type EntityHandle } from '@forgeax/engine-ecs';
// apps/hello/transform-hierarchy -- ChildOf hierarchy "parent moves, child
// follows" visual exemplar
// (feat-20260531-render-consume-global-transform-hierarchy / M3 / w12).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - createRenderer + new World() (NOT createApp) -- the explicit path
//     that lets the demo own component registration + the propagate wiring.
//   - registerPropagateTransforms(world) -- this wires the per-frame kernel
//     that derives every entity's resolved GlobalTransform.world mat4 (root: world =
//     compose(local); child: world = parent.world x compose(local)). The
//     Every transform-bearing entity carries the ordinary GlobalTransform
//     output component as the C-carrier pair; a ChildOf entity therefore has
//     an authored local input and an automatically materialized world output.
//   - A non-identity parent (pos x shifted) + a child entity carrying
//     ChildOf{parent} + Transform (local offset) + MeshFilter + MeshRenderer.
//     The child's GlobalTransform.world = parent.world x child-local, so moving the
//     parent at runtime drags the child across the screen.
//   - Runtime parent move: a frame system slides the parent back and forth
//     along +X via world.set(parent, Transform). The next world.update(1 / 60).unwrap()
//     runs propagateTransforms, the extract stage reads the child's refreshed
//     GlobalTransform.world, and the child moves with the parent. The dual-frame
//     smoke (scripts/smoke-dawn.mjs) is the machine-checkable proof of this;
//     this demo is the human/orchestrator visual confirmation surface
//     (charter P5 produce/consume split).
//
// Scene: one parent cube (offset +X, the "anchor") and one child cube
// (ChildOf the parent, local offset +Y) so the pair reads as a vertical
// stack that translates together when the parent moves. A static reference
// sphere sits off to the side and is NOT part of the hierarchy, giving the
// eye (and the smoke's stability check) a fixed landmark.

import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import {
  ChildOf,
  projectHierarchy,
  propagateTransforms,
  GlobalTransform,
  Transform,
  registerPropagateTransforms,
} from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';

import { World } from '@forgeax/engine-ecs';

import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { setMalformedParentEdge } from './test-fixtures/malformed-hierarchy-edge';

const DATAFLOW_WORKLOADS = [
  { id: 'flat-dynamic', entityCount: 10_000, movers: 10_000, shape: 'flat' },
  { id: 'hierarchy-dynamic', entityCount: 10_000, movers: 10_000, shape: 'hierarchy' },
  { id: 'sparse-dynamic', entityCount: 100_000, movers: 1, shape: 'sparse' },
  { id: 'structural-churn', entityCount: 100_000, movers: 10_000, shape: 'churn' },
  { id: 'multi-view', entityCount: 100_000, movers: 10_000, shape: 'multi-view' },
  { id: 'temporal', entityCount: 10_000, movers: 10_000, shape: 'temporal' },
] as const;

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[transform-hierarchy] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[transform-hierarchy] EngineEnvironmentError: webgpu inner=${code}`);
  } else {
    console.error('[transform-hierarchy] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createRenderer (explicit path; no createApp).
  const rendererResult = await createRenderer(target, {}, forgeaxBundlerAdapter());
  if (!rendererResult.ok) {
    console.error('[transform-hierarchy] renderer construction failed:', rendererResult.error);
    return;
  }
  const renderer = rendererResult.value;
  console.warn(`[transform-hierarchy] backend=${renderer.inspect().capabilities.backendKind}`);


  // Step 2: wire the propagate kernel. The registerPropagateTransforms line
  // is the whole point of this demo -- it derives every entity's
  // GlobalTransform.world each frame so the ChildOf entity follows its parent.
  // The world matrix is owned by GlobalTransform; Transform's generic ECS
  // requirement materializes that derived column at spawn without a scene scan.
  const world = new World();
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  const frameRequest = {
    leases: [worldAttachment1.value],
    camera: { lease: worldAttachment1.value },
    environment: { lease: worldAttachment1.value },
  };

  registerPropagateTransforms(world);

  // Step 3: register the standard PBR material shared by every body.
  const materialHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
    ],
    values: {
      baseColor: [0.7, 0.7, 0.7],
      metallic: 0.0,
      roughness: 0.4,
    },
  } as MaterialAsset);

  // Step 4: spawn the hierarchy. Parent is non-identity (offset -0.6 on X).
  const parent = world
    .spawn(
      {
        component: Transform,
        data: { pos: [-0.6, -0.4, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();

  // Child carries ChildOf{parent} + a local +Y offset. Its world position is
  // parent.world x child-local, so it sits above the parent and translates
  // with it. scale is local (multiplied by the parent's 0.4).
  const child = world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, 2.0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1]},
      },
      { component: ChildOf, data: { parent } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();

  // Static reference sphere -- NOT in the hierarchy. A fixed landmark so the
  // viewer (and the smoke stability check) has something that stays put.
  const staticSphere = world
    .spawn(
      {
        component: Transform,
        data: { pos: [1.4, 0.0, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();

  // Probe-only entities have no render components. They let the real host
  // exercise a bounded cycle without replacing the visible parent/child oracle
  // or creating a second scene implementation.
  const cycleA = world
    .spawn(
      { component: Transform, data: { pos: [-2, -2, 0] } },
      { component: ChildOf, data: { parent } },
    )
    .unwrap();
  const cycleB = world
    .spawn(
      { component: Transform, data: { pos: [2, -2, 0] } },
      { component: ChildOf, data: { parent } },
    )
    .unwrap();

  // Step 5: directional light.
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.4, -0.6, -0.7],
        color: [1, 1, 1],
        intensity: 1.5,
      },
    })
    .unwrap();

  // Step 6: camera.
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 7]} },
      {
        component: Camera,
        data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
      },
    )
    .unwrap();

  // Step 7: a frame system slides the parent left<->right along X. The slide
  // runs as an unconstrained system and the parent's NEXT-frame GlobalTransform.world
  // picks up the change -- a one-frame latency that is invisible at rAF rates
  // and keeps the demo's data flow obvious (Transform write -> next-frame
  // propagate -> extract). The child's world position tracks the parent every
  // frame, so the stack visibly translates together.
  const hudEl = document.getElementById('th-hud');
  let phase = 0;
  let paused = false;

  world.addSystem(Update, {
    name: 'transform-hierarchy-parent-slide',
    queries: [],
    fn: () => {
      if (paused) return;
      phase += 0.02;
      const parentX = -0.6 + 1.2 * Math.sin(phase);
      const setRes = world.set(parent, Transform, { pos: [parentX, 0, 0]});
      if (setRes.ok) {
        if (hudEl) hudEl.textContent = `parent.pos[0] = ${parentX.toFixed(2)} (child follows)`;
      } else {
        // charter P3: surface the failure rather than silently dropping it.
        console.error('[transform-hierarchy] parent move world.set failed:', setRes.error.code);
      }
    },
  });

  const projectionIds = new WeakMap<object, number>();
  let nextProjectionId = 1;
  // Keep a real stale handle for the malformed-edge probe. The ECS reserves
  // 0xffffffff as the explicit null-entity sentinel, so it must not be used
  // to represent a despawned parent.
  const staleParent = world.spawn({ component: Transform, data: {} }).unwrap();
  world.despawn(staleParent).unwrap();

  function projectionId(snapshot: object): number {
    const existing = projectionIds.get(snapshot);
    if (existing !== undefined) return existing;
    const id = nextProjectionId++;
    projectionIds.set(snapshot, id);
    return id;
  }

  function transformSnapshot(entity: EntityHandle): { pos: number[]; world: number[] } | null {
    const result = world.get(entity, Transform);
    const global = world.get(entity, GlobalTransform);
    if (!result.ok || !global.ok) return null;
    return {
      pos: Array.from(result.value.pos),
      world: Array.from(global.value.world),
    };
  }

  function sceneSnapshot() {
    const hierarchy = projectHierarchy(world);
    return {
      projectionId: projectionId(hierarchy),
      diagnostics: hierarchy.diagnostics.map((item) => ({
        code: item.code,
        expected: item.expected,
        hint: item.hint,
        detail: { ...item.detail },
      })),
      entities: {
        parent,
        child,
        staticSphere,
        cycleA,
        cycleB,
      },
      child: transformSnapshot(child),
      staticSphere: transformSnapshot(staticSphere),
    };
  }

  function setParentIfNeeded(entity: EntityHandle, nextParent: EntityHandle) {
    const current = world.get(entity, ChildOf);
    if (current.ok && current.value.parent === nextParent) {
      return { ok: true, changed: false };
    }
    const result = world.set(entity, ChildOf, { parent: nextParent });
    return { ok: result.ok, changed: true, error: result.ok ? undefined : result.error.code };
  }

  function drawProbeFrame(): { ok: boolean; error?: string } {
    const result = renderer.draw(frameRequest);
    return result.ok ? { ok: true } : { ok: false, error: result.error.code };
  }

  const controller = {
    describeDataflow() {
      return {
        schemaVersion: 1,
        seed: 20260901,
        timestep: 1 / 60,
        camera: { position: [0, 0, 7], target: [0, 0, 0], fovRadians: Math.PI / 4 },
        frameCount: 60,
        workloads: DATAFLOW_WORKLOADS,
        frameIdentity: 'runtime-probe-requires-exact-head',
      };
    },
    beginProbe(): ReturnType<typeof sceneSnapshot> {
      paused = true;
      if (hudEl) hudEl.textContent = 'hierarchy probe paused';
      const reset = world.set(parent, Transform, {
        pos: [-0.6, -0.4, 0],
        quat: [0, 0, 0, 1],
        scale: [0.4, 0.4, 0.4],
      });
      if (!reset.ok) throw reset.error;
      const propagation = propagateTransforms(world);
      if (!propagation.ok) throw propagation.error;
      const draw = drawProbeFrame();
      if (!draw.ok) throw new Error(`probe baseline draw failed: ${draw.error}`);
      return sceneSnapshot();
    },
    injectFaults() {
      paused = true;
      // The public relationship owner rejects these malformed writes. The
      // hello diagnostic journey uses a test-owned internal fixture so it can
      // exercise Scene's fail-closed recovery without reopening that bypass.
      setMalformedParentEdge(world, child, staleParent, ChildOf);
      setMalformedParentEdge(world, cycleA, cycleB, ChildOf);
      setMalformedParentEdge(world, cycleB, cycleA, ChildOf);
      const propagation = propagateTransforms(world);
      if (!propagation.ok) console.error(propagation.error);
      const draw = drawProbeFrame();
      if (!draw.ok) throw new Error(`probe fault draw failed: ${draw.error}`);
      return {
        snapshot: sceneSnapshot(),
        propagation: propagation.ok
          ? { ok: true as const }
          : {
              ok: false as const,
              code: propagation.error.code,
              expected: propagation.error.expected,
              hint: propagation.error.hint,
              detail: propagation.error.detail ? { ...propagation.error.detail } : null,
            },
      };
    },
    repairFaults() {
      paused = true;
      const repairs = [
        setParentIfNeeded(child, parent),
        setParentIfNeeded(cycleA, parent),
        setParentIfNeeded(cycleB, parent),
      ];
      const propagation = propagateTransforms(world);
      const draw = drawProbeFrame();
      if (!draw.ok) throw new Error(`probe repair draw failed: ${draw.error}`);
      return {
        repairs,
        propagation: propagation.ok ? { ok: true as const } : { ok: false as const, code: propagation.error.code },
        snapshot: sceneSnapshot(),
      };
    },
    cleanup() {
      return this.repairFaults();
    },
    resume() {
      paused = false;
      if (hudEl) hudEl.textContent = 'parent slides; child follows';
      return { ok: true };
    },
  };
  (globalThis as typeof globalThis & { __forgeaxTransformHierarchy?: typeof controller }).__forgeaxTransformHierarchy = controller;

  // Step 8: rAF loop. world.update(1 / 60).unwrap() runs the schedule (propagateTransforms +
  // the parent-slide system) before each draw.
  function frame(): void {
    if (paused) {
      requestAnimationFrame(frame);
      return;
    }
    const update = world.update(1 / 60);
    if (!update.ok) {
      console.error('[transform-hierarchy] world.update failed:', update.error.code);
      requestAnimationFrame(frame);
      return;
    }
    const draw = renderer.draw(frameRequest);
    if (!draw.ok) {
      console.error('[transform-hierarchy] draw failed:', draw.error.code);
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  console.warn('[transform-hierarchy] running. Parent slides automatically; child follows.');
}
