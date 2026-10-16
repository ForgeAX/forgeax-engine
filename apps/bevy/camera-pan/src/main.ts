import { Time, Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildCameraPanWorld, cameraPanInput, stepCameraPan } from './camera-pan';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-camera-pan: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) console.error('[bevy-camera-pan] no usable backend:', error);
  else console.error('[bevy-camera-pan] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) return console.error('[bevy-camera-pan] createApp failed:', appResult.error);
  const app = appResult.value;
  buildCameraPanWorld(app.world);
  app.world.addSystem(Update, {
    name: 'pan-camera',
    queries: [],
    fn: (world) => {
      const dt = world.hasResource('Time') ? world.getResource(Time).delta : 0;
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      stepCameraPan(world, dt, cameraPanInput(snapshot));
    },
  });
  const captureWindow = globalThis as typeof globalThis & {
    __prepareCameraPanCapture?: () => Promise<void>;
  };
  captureWindow.__prepareCameraPanCapture = async (): Promise<void> => {
    app.world.update(1 / 60).unwrap();
  };
  const started = app.start();
  if (!started.ok) console.error('[bevy-camera-pan] app.start failed:', started.error);
  if (started.ok) (globalThis as { __bevyCameraPanReady?: boolean }).__bevyCameraPanReady = true;
}
