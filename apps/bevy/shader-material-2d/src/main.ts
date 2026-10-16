import { createApp } from '@forgeax/engine-app/browser';
import type { TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import './shader-material-2d.wgsl';
import { buildShaderMaterial2dWorld, makeTextureAsset, makeTexturePixels } from './scene';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-shader-material-2d: missing <canvas id="app">');

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter() },
  );
  if (!appResult.ok) {
    console.error('[bevy-shader-material-2d] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const pixels = makeTexturePixels();
  const texture = makeTextureAsset(pixels);
  const textureHandle = app.world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', texture);
  buildShaderMaterial2dWorld(app.world, unwrapHandle(textureHandle), target.width / Math.max(target.height, 1));
  app.onError((error) => console.error('[bevy-shader-material-2d] app error:', error.code, error.hint));
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-shader-material-2d] app.start failed:', started.error);
    return;
  }
  const debugGlobal = globalThis as typeof globalThis & {
    __bevyShaderMaterial2dReady?: boolean;
    __prepareShaderMaterial2dCapture?: () => Promise<void>;
  };
  debugGlobal.__prepareShaderMaterial2dCapture = async () => {
    const updated = app.world.update(1 / 60);
    if (!updated.ok) throw updated.error;
  };
  debugGlobal.__bevyShaderMaterial2dReady = true;
}
