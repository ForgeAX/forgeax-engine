import { createApp } from '@forgeax/engine-app/browser';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import './shader-material.wgsl';
import { buildShaderMaterialWorld, makeTextureAsset, makeTexturePixels } from './scene';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-shader-material: missing <canvas id="app">');

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter() },
  );
  if (!result.ok) {
    console.error('[bevy-shader-material] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  const pixels = makeTexturePixels();
  const texture = makeTextureAsset(pixels);
  const textureHandle = assets.create(texture).unwrap();
  if (!buildShaderMaterialWorld(app.world, textureHandle, target.width / Math.max(target.height, 1))) {
    console.error('[bevy-shader-material] scene construction failed');
    return;
  }
  app.onError((error) => console.error('[bevy-shader-material] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) console.error('[bevy-shader-material] app.start failed:', started.error);
}
