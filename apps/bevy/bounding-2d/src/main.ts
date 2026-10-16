import { createApp } from '@forgeax/engine-app/browser';
import { Update, Time } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine-input';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  BOUNDING_2D_TESTS,
  buildBounding2dWorld,
  computeBounding2dState,
  drawBounding2d,
  type Bounding2dTest,
} from './bounding-2d';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-bounding-2d: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[bevy-bounding-2d] no usable backend:', err);
  else console.error('[bevy-bounding-2d] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-bounding-2d] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  if (!app.debugDraw) {
    console.error('[bevy-bounding-2d] app.debugDraw missing — debug-draw auto-attach failed');
    return;
  }
  const debugDraw = app.debugDraw;
  buildBounding2dWorld(app.world);
  let modeIndex = 2;

  app.world.addSystem(Update, {
    name: 'bounding-2d',
    queries: [],
    fn: (world) => {
      const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (input.keyboard.justPressed('Space')) modeIndex = (modeIndex + 1) % BOUNDING_2D_TESTS.length;
      const time = world.getResource(Time);
      const mode: Bounding2dTest = BOUNDING_2D_TESTS[modeIndex] as Bounding2dTest;
      drawBounding2d(debugDraw, computeBounding2dState(time.elapsed, mode));
    },
  });

  const started = app.start();
  if (!started.ok) console.error('[bevy-bounding-2d] app.start failed:', started.error);
}
