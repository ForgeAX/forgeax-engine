import { createApp } from '@forgeax/engine-app/browser';
import { unwrapHandle } from '@forgeax/engine-types';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpriteSliceWorld, makeSlicePixels, TEXTURE_SIZE } from './sprite-slice.js';
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-sprite-slice: missing <canvas id="app">');
bootstrap(canvas).catch((error: unknown) => { if (error instanceof EngineEnvironmentError) console.error('[bevy-sprite-slice] no usable backend:', error); else console.error('[bevy-sprite-slice] bootstrap error:', error); });
async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) return console.error('[bevy-sprite-slice] createApp failed:', result.error);
  const app = result.value;
  const pixels = makeSlicePixels();
  const texture = {
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: TEXTURE_SIZE, height: TEXTURE_SIZE } },
    format: 'rgba8unorm-srgb' as const,
    data: pixels,
    colorSpace: 'srgb' as const,
    mips: { kind: 'none' as const },
  };
  const textureHandle = app.world.allocSharedRef('TextureAsset', texture);
  buildSpriteSliceWorld(app.world, unwrapHandle(textureHandle));
  const started = app.start();
  if (!started.ok) return console.error('[bevy-sprite-slice] app.start failed:', started.error);
  (globalThis as { __bevySpriteSliceReady?: boolean }).__bevySpriteSliceReady = true;
}
