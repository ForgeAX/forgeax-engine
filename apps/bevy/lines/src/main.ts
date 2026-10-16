import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildLinesWorld } from './lines.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[lines] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;

  buildLinesWorld(app.world);

  const started = app.start();
  if (!started.ok) {
    console.error('[lines] app.start() failed:', started.error);
  }
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
bootstrap(canvas);