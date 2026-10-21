// apps/bevy/mesh-picking - reproduction of Bevy's `mesh_picking` example.
//
// Bevy source: "click to select/highlight 3D shapes via AABB raycasting."
// forgeax mapping: `pick()` from @forgeax/engine-picking does AABB-level raycasting.
// Key insight: built-in HANDLE_CUBE lacks AABB → use createBoxGeometry which auto-computes it.
//
// Scene: 4 shapes (box, sphere, capsule, torus) in a row, click to highlight.

import { createApp } from '@forgeax/engine-app/browser';
import type { EntityHandle } from '@forgeax/engine-ecs';

import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';

import { createBoxGeometry, createSphereGeometry, createCapsuleGeometry, createTorusGeometry } from '@forgeax/engine-geometry';
import { pick } from '@forgeax/engine-picking';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-mesh-picking: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-mesh-picking] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-mesh-picking] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  const world = app.world;

  // ── Materials ──────────────────────────────────────────────────────────
  const defaultMat = assets.create(Materials.standard({ baseColor: [0.8, 0.8, 0.8, 1] })).unwrap();
  const highlightMat = assets.create(Materials.standard({ baseColor: [1, 0.85, 0.1, 1] })).unwrap();

  // ── Meshes with AABB (createBoxGeometry etc. auto-compute AABB) ─────────
  const boxGeom = createBoxGeometry(0.5, 0.5, 0.5, 1, 1, 1);
  const sphereGeom = createSphereGeometry(0.4, 32, 16);
  const capsuleGeom = createCapsuleGeometry(0.2, 0.6, 32, 8);
  const torusGeom = createTorusGeometry(0.35, 0.1, 32, 16);

  if (!boxGeom.ok || !sphereGeom.ok || !capsuleGeom.ok || !torusGeom.ok) {
    console.error('[bevy-mesh-picking] geometry creation failed');
    return;
  }

  const boxHandle = assets.create(boxGeom.value).unwrap();
  const sphereHandle = assets.create(sphereGeom.value).unwrap();
  const capsuleHandle = assets.create(capsuleGeom.value).unwrap();
  const torusHandle = assets.create(torusGeom.value).unwrap();

  // ── Spawn shapes in a row ───────────────────────────────────────────────
  const spacing = 1.5;
  const shapes: { entity: EntityHandle; handle: typeof boxHandle }[] = [];

  shapes.push({
    entity: world.spawn(
      { component: Transform, data: { pos: [-spacing * 1.5, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: boxHandle } },
      { component: MeshRenderer, data: { materials: [defaultMat] } },
    ).unwrap(),
    handle: boxHandle,
  });
  shapes.push({
    entity: world.spawn(
      { component: Transform, data: { pos: [-spacing * 0.5, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: sphereHandle } },
      { component: MeshRenderer, data: { materials: [defaultMat] } },
    ).unwrap(),
    handle: sphereHandle,
  });
  shapes.push({
    entity: world.spawn(
      { component: Transform, data: { pos: [spacing * 0.5, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: capsuleHandle } },
      { component: MeshRenderer, data: { materials: [defaultMat] } },
    ).unwrap(),
    handle: capsuleHandle,
  });
  shapes.push({
    entity: world.spawn(
      { component: Transform, data: { pos: [spacing * 1.5, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: torusHandle } },
      { component: MeshRenderer, data: { materials: [defaultMat] } },
    ).unwrap(),
    handle: torusHandle,
  });

  // ── Light ───────────────────────────────────────────────────────────────
  world.spawn(
    { component: Transform, data: { pos: [0, 4, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 400, range: 40 } },
  );

  // ── Camera ──────────────────────────────────────────────────────────────
  const cameraEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  ).unwrap();

  // ── Click → pick → highlight ────────────────────────────────────────────
  target.addEventListener('click', (e) => {
    const rect = target.getBoundingClientRect();
    propagateTransforms(world);
    const hit = pick(
      world,
      cameraEntity,
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
    );
    // Reset all shapes to default, then highlight the hit
    for (const s of shapes) {
      world.set(s.entity, MeshRenderer, { materials: [defaultMat] });
    }
    if (hit) {
      world.set(hit.entity, MeshRenderer, { materials: [highlightMat] });
      console.log(`[picking] hit entity=${hit.entity} distance=${hit.distance.toFixed(3)}`);
    } else {
      console.log('[picking] miss');
    }
  });

  // ── Start ───────────────────────────────────────────────────────────────
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-mesh-picking] app.start() failed:', started.error);
  }
}
