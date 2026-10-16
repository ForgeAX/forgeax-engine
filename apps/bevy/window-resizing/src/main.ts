import { Update } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app/browser';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildWindowResizingWorld, stepResize } from './window-resizing.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[window-resizing] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;

  buildWindowResizingWorld(app.world);

  app.world.addSystem(Update, {
    name: 'window-resize',
    queries: [],
    fn: (world) => {
      const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      const res = stepResize(snapshot);
      if (res) {
        target.width = res.w;
        target.height = res.h;
        console.log(`[window-resizing] ${res.w}x${res.h}`);
      }
    },
  });

  const started = app.start();
  if (!started.ok) {
    console.error('[window-resizing] app.start() failed:', started.error);
  }
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
bootstrap(canvas);