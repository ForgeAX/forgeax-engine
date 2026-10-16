// apps/bevy/lighting - reproduction of Bevy's `lighting` example.
//
// Static render — no per-frame animation needed. The 4 light types
// (PointLight, SpotLight, DirectionalLight, Skylight) compose correctly.

import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildLightingWorld } from './lighting';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-lighting: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  console.error('[bevy-lighting] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-lighting] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;

  console.warn(`[bevy-lighting] state=${app.renderer.inspect().state}`);

  buildLightingWorld(app.world);

  const started = app.start();
  if (!started.ok) console.error('[bevy-lighting] app.start failed:', started.error);
}
