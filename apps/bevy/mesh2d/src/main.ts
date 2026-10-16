import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildMesh2dWorld } from './mesh2d.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-mesh2d: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-mesh2d] no usable backend:', error);
  else console.error('[bevy-mesh2d] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-mesh2d] createApp failed:', appResult.error);
  const app = appResult.value;
  buildMesh2dWorld(app.world);
  const started = app.start();
  if (!started.ok) return console.error('[bevy-mesh2d] app.start failed:', started.error);
  (globalThis as { __bevyMesh2dReady?: boolean }).__bevyMesh2dReady = true;
}
