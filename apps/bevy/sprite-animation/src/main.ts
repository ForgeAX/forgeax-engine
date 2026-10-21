// Reproduction of Bevy's `sprite_animation` example.

import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { ATLAS_HEIGHT, ATLAS_WIDTH, buildSpriteAnimationWorld, makeAtlasPixels, tickSpriteAnimation } from './sprite-animation';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-sprite-animation: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[bevy-sprite-animation] no usable backend:', err);
  else console.error('[bevy-sprite-animation] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-sprite-animation] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  console.warn(`[bevy-sprite-animation] backend=${app.renderer.inspect().capabilities.backendKind}`);
  const pixels = makeAtlasPixels();
  const texture = {
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: ATLAS_WIDTH, height: ATLAS_HEIGHT } },
    format: 'rgba8unorm-srgb' as const,
    data: pixels,
    colorSpace: 'srgb' as const,
    mips: { kind: 'none' as const },
  };
  const handle = assets.create(texture).unwrap();
  buildSpriteAnimationWorld(app.world, handle);
  const system = app.world.addSystem(Update, {
    name: 'sprite-animation-tick',
    queries: [],
    fn: (world) => tickSpriteAnimation(world),
  });
  if (!system.ok) {
    console.error('[bevy-sprite-animation] system registration failed:', system.error);
    return;
  }
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-sprite-animation] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  (globalThis as typeof globalThis & { __bevySpriteAnimationReady?: boolean }).__bevySpriteAnimationReady = true;
}
