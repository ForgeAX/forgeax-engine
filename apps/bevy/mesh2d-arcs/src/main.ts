import { Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  buildMesh2dArcsWorld,
  drawMesh2dArcsBounds,
  makeTextureAsset,
  makeTexturePixels,
} from './mesh2d-arcs.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-mesh2d-arcs: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-mesh2d-arcs] no usable backend:', error);
  else console.error('[bevy-mesh2d-arcs] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-mesh2d-arcs] createApp failed:', appResult.error);
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  if (!app.debugDraw) return console.error('[bevy-mesh2d-arcs] debug-draw is unavailable');

  const pixels = makeTexturePixels();
  const texture = makeTextureAsset(pixels);
  const textureHandle = assets.create(texture).unwrap();

  const scene = buildMesh2dArcsWorld(app.world, textureHandle);
  const debugDraw = app.debugDraw;
  app.world.addSystem(Update, {
    name: 'draw-mesh2d-arcs-bounds',
    queries: [],
    fn: () => drawMesh2dArcsBounds(debugDraw, scene),
  });
  const started = app.start();
  if (!started.ok) return console.error('[bevy-mesh2d-arcs] app.start failed:', started.error);
  (globalThis as { __bevyMesh2dArcsReady?: boolean }).__bevyMesh2dArcsReady = true;
}
