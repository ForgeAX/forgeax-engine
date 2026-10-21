// apps/bevy/blend-modes - reproduction of Bevy's `blend_modes` example.
//
// Bevy source: 5 spheres in a row with different alpha blend modes over a checkerboard plane.
// forgeax: construct MaterialAsset directly with per-sphere renderState.blend.

import { createApp } from '@forgeax/engine-app/browser';

import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { Materials } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { PointLight } from '@forgeax/engine-render';

import type { MaterialAsset } from '@forgeax/engine-runtime';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-blend-modes: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-blend-modes] bootstrap error:', err);
});

function blendMaterial(
  baseColor: readonly [number, number, number, number],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blend: any,
): MaterialAsset {
  return {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { ...{ blend }, tags: { LightMode: 'Forward' }, passKind: 'forward' as const } }],
    values: { baseColor },
  };
}

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-blend-modes] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  const world = app.world;
const primitiveCube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();


  // ── Ground plane ────────────────────────────────────────────────────────
  const planeMat = assets.create(Materials.unlit([0.3, 0.3, 0.3, 1])).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, -1.5, 0], quat: [0, 0, 0, 1], scale: [16, 0.02, 16] } },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [planeMat] } },
  );

  // ── 5 spheres with different blend modes ────────────────────────────────
  const sphereGeom = createSphereGeometry(0.4, 32, 16);
  if (!sphereGeom.ok) { console.error('sphere geom failed'); return; }
  const sphereHandle = assets.create(sphereGeom.value).unwrap();

  // Opaque (no blend) — alpha=1 since there's no transparency
  const opaqueMat = assets.create(Materials.unlit([0.9, 0.2, 0.3, 1])).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [-4, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: sphereHandle } },
    { component: MeshRenderer, data: { materials: [opaqueMat] } },
  );

  // Blend (standard alpha: src-alpha / one-minus-src-alpha)
  const blendMat = assets.create(blendMaterial([0.9, 0.2, 0.3, 0.5], {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  })).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [-2, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: sphereHandle } },
    { component: MeshRenderer, data: { materials: [blendMat] } },
  );

  // Premultiplied (one / one-minus-src-alpha)
  const premultMat = assets.create(blendMaterial([0.9, 0.2, 0.3, 0.5], SPRITE_PREMULTIPLIED_ALPHA_BLEND)).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: sphereHandle } },
    { component: MeshRenderer, data: { materials: [premultMat] } },
  );

  // Add (one / one)
  const addMat = assets.create(blendMaterial([0.9, 0.2, 0.3, 0.5], {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  })).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [2, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: sphereHandle } },
    { component: MeshRenderer, data: { materials: [addMat] } },
  );

  // Multiply (dst / zero)
  const mulMat = assets.create(blendMaterial([0.9, 0.2, 0.3, 0.5], {
    color: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
    alpha: { srcFactor: 'dst', dstFactor: 'zero', operation: 'add' },
  })).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [4, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: sphereHandle } },
    { component: MeshRenderer, data: { materials: [mulMat] } },
  );

  // ── Light ───────────────────────────────────────────────────────────────
  world.spawn(
    { component: Transform, data: { pos: [4, 8, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 600, range: 40 } },
  );

  // ── Camera ──────────────────────────────────────────────────────────────
  world.spawn(
    { component: Transform, data: { pos: [0, 2.5, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  // ── Start ───────────────────────────────────────────────────────────────
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-blend-modes] app.start() failed:', started.error);
  }
}
