import { Time, Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildCameraOrbitWorld, cameraOrbitInput, stepCameraOrbit } from './camera-orbit';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-camera-orbit: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-camera-orbit] no usable backend:', error);
  else console.error('[bevy-camera-orbit] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-camera-orbit] createApp failed:', appResult.error);
  const app = appResult.value;
  buildCameraOrbitWorld(app.world);
  app.world.addSystem(Update, {
    name: 'orbit-camera',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time') ? world.getResource(Time).delta : 0;
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      stepCameraOrbit(world, dt, cameraOrbitInput(snapshot));
    },
  });
  const started = app.start();
  if (!started.ok) console.error('[bevy-camera-orbit] app.start failed:', started.error);
}
