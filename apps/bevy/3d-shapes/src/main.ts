// apps/bevy/3d-shapes - reproduction of Bevy's `3d_shapes` example.
//
// Bevy source (references/repos/bevy/examples/3d/3d_shapes.rs): a row of shape
// primitives generated from Bevy's shape primitives (Cuboid / Sphere / Cylinder
// / Capsule3d / Torus / Cone / …), each meshed and placed along X, lit and
// viewed from a fixed camera.
//
// forgeax mapping: exercises all 7 @forgeax/engine-geometry factories — the
// new createCapsuleGeometry (solo round 20260713-153135) sits at the row center.
// The scene recipe is the shared SSOT builder in src/shapes.ts so this app and
// the headless dawn smoke render the identical World (memory
// smoke-script-duplicate-scene-must-stay-in-sync-with-main).

import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildShapesWorld } from './shapes';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-3d-shapes: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err) => {
  console.error('[bevy-3d-shapes] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-3d-shapes] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;


  const placed = buildShapesWorld(app.world);
  console.warn(`[bevy-3d-shapes] placed ${placed} shapes`);

  const started = app.start();
  if (!started.ok) console.error('[bevy-3d-shapes] app.start failed:', started.error);
}
