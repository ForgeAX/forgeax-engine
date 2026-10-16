// apps/bevy/cubic-splines - reproduction of Bevy's `cubic_splines` example.
//
// Bevy source (references/repos/bevy/examples/math/cubic_splines.rs): a smooth curve
// passing through control points, built via CubicCardinalSpline::new_catmull_rom(pts)
// .to_curve() and drawn as a dense polyline.
//
// forgeax mapping — a STATIC demo (the curve is baked once at startup):
//   - createApp -> owns the frame loop; no Update system needed (the curve does not move).
//   - buildCubicSplinesWorld -> bakes a bead per curve sample via vec3.catmullRom (the
//     Catmull-Rom sampler added in solo round 20260713-203432, mapping Bevy's
//     CubicCardinalSpline::new_catmull_rom .position(t)) + control-point markers.
//   - app.start() -> renders the static curve.
//
// The World + curve sampler live in the shared src/cubic-splines.ts (SSOT for this app
// AND the dawn smoke), so the two never drift.

import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildCubicSplinesWorld } from './cubic-splines';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-cubic-splines: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-cubic-splines] no usable backend:', err);
  } else {
    console.error('[bevy-cubic-splines] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-cubic-splines] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-cubic-splines] state=${app.renderer.inspect().state}`);

  buildCubicSplinesWorld(app.world);

  const started = app.start();
  if (!started.ok) console.error('[bevy-cubic-splines] app.start failed:', started.error);
}
