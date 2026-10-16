import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  buildRandomSamplingWorld,
  spawnSamplePoint,
  stepRandomSampling,
} from './random-sampling.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[random-sampling] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const { wireframeHalf, pointMat } = buildRandomSamplingWorld(app.world);

  let mode: 'interior' | 'boundary' = 'interior';

  app.world.addSystem(Update, {
    name: 'random-sampling',
    queries: [],
    fn: (world) => {
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      const { spawn, toggleMode } = stepRandomSampling(snapshot);
      if (toggleMode) {
        mode = mode === 'interior' ? 'boundary' : 'interior';
      }
      for (let i = 0; i < spawn; i++) {
        spawnSamplePoint(world, mode, wireframeHalf, pointMat);
      }
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error('[random-sampling] app.start() failed:', started.error);
  }
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
bootstrap(canvas);