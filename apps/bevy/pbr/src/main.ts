// apps/bevy/pbr — reproduction of Bevy's `pbr` example.
//
// Bevy source (references/repos/bevy/examples/3d/pbr.rs):
// "This example shows how to configure Physically Based Rendering (PBR)
// parameters." 11×5 sphere grid with varying metallic/roughness +
// DirectionalLight + orthographic camera.
//
// forgeax mapping: thin over existing primitives — no engine gap.
//   - `Materials.standard({ metallic, roughness })` already exists
//   - `Materials.unlit()` already exists
//   - DirectionalLight + orthographic camera already exist

import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildPbrWorld } from './pbr.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-pbr: missing <canvas id="app"> in index.html');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-pbr] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;

  buildPbrWorld(app.world);

  const started = app.start();
  if (!started.ok) console.error('[bevy-pbr] app.start failed:', started.error);
}

bootstrap(canvas).catch((err) => {
  console.error('[bevy-pbr] bootstrap error:', err);
});
