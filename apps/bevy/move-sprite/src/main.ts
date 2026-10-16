// Reproduction of Bevy's `move_sprite` example.

import { createApp } from '@forgeax/engine-app/browser';
import { Time, Update } from '@forgeax/engine-ecs';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildMoveSpriteWorld, makeSpritePixels, SPRITE_SIZE, stepMoveSprite } from './move-sprite';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-move-sprite: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[bevy-move-sprite] no usable backend:', err);
  else console.error('[bevy-move-sprite] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-move-sprite] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  console.warn(`[bevy-move-sprite] state=${app.renderer.inspect().state}`);
  const pixels = makeSpritePixels();
  const texture = {
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: SPRITE_SIZE, height: SPRITE_SIZE } },
    format: 'rgba8unorm-srgb' as const,
    data: pixels,
    colorSpace: 'srgb' as const,
    mips: { kind: 'none' as const },
  };
  const handle = app.world.allocSharedRef('TextureAsset', texture);
  buildMoveSpriteWorld(app.world, unwrapHandle(handle));
  app.world.addSystem(Update, {
    name: 'move-sprite',
    queries: [],
    fn: (world) => stepMoveSprite(world, world.hasResource('Time') ? world.getResource(Time).delta : 0),
  });
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-move-sprite] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  (globalThis as typeof globalThis & { __bevyMoveSpriteReady?: boolean }).__bevyMoveSpriteReady = true;
}
