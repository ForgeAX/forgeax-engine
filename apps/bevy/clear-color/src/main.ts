import { Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildClearColorWorld, stepClearColor } from './clear-color.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[clear-color] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;

  buildClearColorWorld(app.world);

  app.world.addSystem(Update, {
    name: 'clear-color-toggle',
    queries: [],
    fn: (world) => {
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      stepClearColor(world, snapshot);
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error('[clear-color] app.start() failed:', started.error);
  }
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('clear-color: missing <canvas id="app"> in index.html');
bootstrap(canvas);