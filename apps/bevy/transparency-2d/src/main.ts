import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildTransparencyWorld, makeTransparencyPixels, TEXTURE_SIZE } from './transparency-2d.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-transparency-2d: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-transparency-2d] no usable backend:', error);
  else console.error('[bevy-transparency-2d] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-transparency-2d] createApp failed:', appResult.error);
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  const pixels = makeTransparencyPixels();
  const texture = {
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: TEXTURE_SIZE, height: TEXTURE_SIZE } },
    format: 'rgba8unorm-srgb' as const,
    data: pixels,
    colorSpace: 'srgb' as const,
    mips: { kind: 'none' as const },
  };
  const handle = assets.create(texture).unwrap();
  buildTransparencyWorld(app.world, handle);
  const started = app.start();
  if (!started.ok) return console.error('[bevy-transparency-2d] app.start failed:', started.error);
  (globalThis as { __bevyTransparency2dReady?: boolean }).__bevyTransparency2dReady = true;
}
