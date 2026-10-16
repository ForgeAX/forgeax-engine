import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { Time, Update } from '@forgeax/engine-ecs';
import { unwrapHandle } from '@forgeax/engine-types';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  buildRotateToCursorWorld,
  cursorPositionFromInput,
  makeShipPixels,
  stepRotateToCursor,
  TEXTURE_SIZE,
} from './rotate-to-cursor.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-rotate-to-cursor: missing <canvas id="app">');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-rotate-to-cursor] no usable backend:', error);
  else console.error('[bevy-rotate-to-cursor] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) return console.error('[bevy-rotate-to-cursor] createApp failed:', result.error);
  const app = result.value;
  const pixels = makeShipPixels();
  const texture = {
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: TEXTURE_SIZE, height: TEXTURE_SIZE } },
    format: 'rgba8unorm-srgb' as const,
    data: pixels,
    colorSpace: 'srgb' as const,
    mips: { kind: 'none' as const },
  };
  const textureHandle = app.world.allocSharedRef('TextureAsset', texture);
  const scene = buildRotateToCursorWorld(app.world, unwrapHandle(textureHandle));
  const cursor = { x: target.width * 0.5, y: target.height * 0.5 };
  app.world.addSystem(Update, {
    name: 'rotate-to-cursor',
    queries: [],
    fn: (world) => {
      void world.getResource(Time).delta;
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (snapshot === undefined) return;
      cursorPositionFromInput(snapshot, cursor);
      stepRotateToCursor(world, scene, cursor.x, cursor.y, target.width, target.height);
    },
  }).unwrap();
  const started = app.start();
  if (!started.ok) return console.error('[bevy-rotate-to-cursor] app.start failed:', started.error);
  (globalThis as { __bevyRotateToCursorReady?: boolean }).__bevyRotateToCursorReady = true;
}
