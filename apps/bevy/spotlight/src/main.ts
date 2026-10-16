// apps/bevy/spotlight - reproduction of Bevy's `spotlight` example.
//
// Static render — no per-frame animation needed. The 4 SpotLights with their
// cone angles produce the characteristic round light spots on the ground.

import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpotlightWorld } from './spotlight.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-spotlight: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-spotlight] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-spotlight] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;


  buildSpotlightWorld(app.world);
  const started = app.start();
  if (!started.ok) console.error('[bevy-spotlight] app.start failed:', started.error);
}
