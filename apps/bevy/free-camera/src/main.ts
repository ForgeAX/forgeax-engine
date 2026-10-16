import { Time, Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildFreeCameraWorld, stepFreeCamera } from './free-camera';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-free-camera: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-free-camera] no usable backend:', error);
  else console.error('[bevy-free-camera] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-free-camera] createApp failed:', appResult.error);
  const app = appResult.value;
  buildFreeCameraWorld(app.world);
  app.world.addSystem(Update, {
    name: 'free-camera',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time') ? world.getResource(Time).delta : 0;
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      stepFreeCamera(world, dt, snapshot);
    },
  });
  const started = app.start();
  if (!started.ok) console.error('[bevy-free-camera] app.start failed:', started.error);
}