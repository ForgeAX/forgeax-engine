// Reproduction of Bevy's `sprite` example: one image-backed Sprite.

import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpriteWorld, makeSpritePixels, SPRITE_SIZE } from './sprite';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-sprite: missing <canvas id="app">');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-sprite] no usable backend:', error);
  } else {
    console.error('[bevy-sprite] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-sprite] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  console.warn(`[bevy-sprite] state=${app.renderer.inspect().state}`);
  const pixels = makeSpritePixels();
  const texture = {
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: SPRITE_SIZE, height: SPRITE_SIZE } },
    format: 'rgba8unorm-srgb' as const,
    data: pixels,
    colorSpace: 'srgb' as const,
    mips: { kind: 'none' as const },
  };
  const handle = assets.create(texture).unwrap();
  buildSpriteWorld(app.world, handle);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-sprite] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  (globalThis as typeof globalThis & { __bevySpriteReady?: boolean }).__bevySpriteReady = true;
}
