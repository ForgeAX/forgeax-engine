// apps/bevy/axes - reproduction of Bevy's `gizmos/axes` example.
//
// Bevy source (references/repos/bevy/examples/gizmos/axes.rs): a `draw_axes` system calls
// `gizmos.axes(transform, length)` for each ShowAxes entity, drawing its local coordinate
// frame as three colored arrows.
//
// forgeax mapping — a debug-draw-front-door demo:
//   - createApp -> owns the frame loop AND auto-attaches app.debugDraw (immediate-mode gizmo
//     overlay, flushed at the end of the frame).
//   - world.addSystem(Update, ...) -> each frame, draw every ShowAxes cube's local axes via the new
//     app.debugDraw.axes(transform.world, length) primitive (solo round 20260713-222551).
//   - app.start() -> the cubes render with their R/G/B local-axis gizmos overlaid.
//
// The World + draw step live in the shared src/axes-demo.ts (SSOT for this app AND the dawn
// smoke), so the two never drift.

import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildAxesWorld, drawAxesForEntities } from './axes-demo';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-axes: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[bevy-axes] no usable backend:', err);
  } else {
    console.error('[bevy-axes] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-axes] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-axes] state=${app.renderer.inspect().state}`);

  if (!app.debugDraw) {
    console.error('[bevy-axes] app.debugDraw missing — debug-draw auto-attach failed');
    return;
  }
  const debugDraw = app.debugDraw;

  buildAxesWorld(app.world);

  // Bevy's draw_axes: each frame, draw every ShowAxes entity's local coordinate frame.
  app.world
    .addSystem(Update, {
      name: 'bevy-axes-draw',
      queries: [],
      fn: () => drawAxesForEntities(app.world, debugDraw),
    })
    .unwrap();

  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-axes] app.start failed:', started.error);
    return;
  }
  (globalThis as { __bevyAxesReady?: boolean }).__bevyAxesReady = true;
}
