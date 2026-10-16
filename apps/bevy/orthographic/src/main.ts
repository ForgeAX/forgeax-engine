// apps/bevy/orthographic — reproduction of Bevy's `orthographic` example.
//
// Bevy source (references/repos/bevy/examples/3d/orthographic.rs):
// "Shows how to create a 3D orthographic view (for isometric-look games or CAD
// applications)." Green plane + 4 brown cubes + PointLight, orthographic camera.
//
// forgeax mapping (thin over existing primitives — no engine gap):
//   - orthographic projection already exists (Camera + orthographic())
//   - scene uses standard PBR materials + PointLight + HANDLE_CUBE

import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildOrthographicWorld } from './orthographic.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-orthographic: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-orthographic] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-orthographic] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;


  buildOrthographicWorld(app.world);
  const started = app.start();
  if (!started.ok) console.error('[bevy-orthographic] app.start failed:', started.error);
}
