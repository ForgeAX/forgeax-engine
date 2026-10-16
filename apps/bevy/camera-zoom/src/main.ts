import { Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildCameraZoomWorld, cameraZoomInput, stepCameraZoom } from './camera-zoom';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-camera-zoom: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-camera-zoom] no usable backend:', error);
  else console.error('[bevy-camera-zoom] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-camera-zoom] createApp failed:', appResult.error);
  const app = appResult.value;
  buildCameraZoomWorld(app.world);
  app.world.addSystem(Update, {
    name: 'zoom-camera',
    queries: [],
    fn: (world) => {
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      stepCameraZoom(world, cameraZoomInput(snapshot));
    },
  });
  const started = app.start();
  if (!started.ok) console.error('[bevy-camera-zoom] app.start failed:', started.error);
}
