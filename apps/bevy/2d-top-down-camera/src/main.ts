import { Time, Update } from '@forgeax/engine-ecs';
// apps/bevy/2d-top-down-camera — reproduction of Bevy's `2d_top_down_camera`
// example. Player icon moves via WASD, orthographic camera smooth-tracks.
//
// Bevy source (references/repos/bevy/examples/camera/2d_top_down_camera.rs):
// "This example showcases a 2D top-down camera with smooth player tracking."
//
// forgeax mapping (thin over existing primitives — no engine gap):
//   - orthographic camera + flat quad floor + player icon
//   - WASD input via InputSnapshot
//   - camera tracking via vec3.smoothDamp

import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildTopDownWorld, stepTopDownCamera } from './top-down-camera.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-2d-top-down-camera: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-2d-top-down-camera] no usable backend:', error);
  else console.error('[bevy-2d-top-down-camera] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-2d-top-down-camera] createApp failed:', appResult.error);
  const app = appResult.value;
  buildTopDownWorld(app.world);
  app.world.addSystem(Update, {
    name: 'top-down-camera',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time') ? world.getResource(Time).delta : 0;
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      stepTopDownCamera(world, dt, snapshot);
    },
  });
  const started = app.start();
  if (!started.ok) console.error('[bevy-2d-top-down-camera] app.start failed:', started.error);
}