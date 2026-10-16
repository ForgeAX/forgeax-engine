import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { Update } from '@forgeax/engine-ecs';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  buildViewportToWorldWorld,
  cursorPositionFromInput,
  stepViewportToWorld,
} from './viewport-to-world';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-viewport-to-world: missing <canvas id="app" />');

const appResult = await createApp(canvas, {}, forgeaxBundlerAdapter());
if (!appResult.ok) {
  console.error('[bevy-viewport-to-world] createApp failed:', appResult.error);
} else {
  const app = appResult.value;
  console.warn(`[bevy-viewport-to-world] state=${app.renderer.inspect().state}`);
  const scene = buildViewportToWorldWorld(app.world);
  const cursor = { x: canvas.width * 0.5, y: canvas.height * 0.5 };

  app.world
    .addSystem(Update, {
      name: 'viewport-to-world-marker',
      queries: [],
      fn: (world) => {
        const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        if (!snapshot) return;
        cursorPositionFromInput(snapshot, cursor);
        stepViewportToWorld(world, scene, cursor.x, cursor.y, canvas.width, canvas.height);
      },
    })
    .unwrap();

  const started = app.start();
  if (!started.ok) console.error('[bevy-viewport-to-world] app.start failed:', started.error);
}
