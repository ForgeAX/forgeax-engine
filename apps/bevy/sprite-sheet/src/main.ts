// Reproduction of Bevy's `sprite_sheet` example.

import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildSpriteSheetWorld, makeSpriteSheetPixels, SHEET_HEIGHT, SHEET_WIDTH, tickSpriteSheet } from './sprite-sheet';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-sprite-sheet: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-sprite-sheet] no usable backend:', error);
  else console.error('[bevy-sprite-sheet] bootstrap failed:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-sprite-sheet] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-sprite-sheet] backend=${app.renderer.inspect().capabilities.backendKind}`);
  const pixels = makeSpriteSheetPixels();
  const texture = {
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: SHEET_WIDTH, height: SHEET_HEIGHT } },
    format: 'rgba8unorm-srgb' as const,
    data: pixels,
    colorSpace: 'srgb' as const,
    mips: { kind: 'none' as const },
  };
  const textureHandle = app.world.allocSharedRef('TextureAsset', texture);
  buildSpriteSheetWorld(app.world, unwrapHandle(textureHandle));
  const system = app.world.addSystem(Update, {
    name: 'sprite-sheet-tick',
    queries: [],
    fn: (world) => tickSpriteSheet(world),
  });
  if (!system.ok) {
    console.error('[bevy-sprite-sheet] system registration failed:', system.error);
    return;
  }
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-sprite-sheet] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  (globalThis as typeof globalThis & { __bevySpriteSheetReady?: boolean }).__bevySpriteSheetReady = true;
}
