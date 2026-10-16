import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildFixedTimestepWorld } from './fixed-timestep.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(
    target,
    { time: { fixedDeltaSeconds: 0.5, maxStepsPerUpdate: 4, maxDeltaSeconds: 2.5 } },
    forgeaxBundlerAdapter(),
  );
  if (!appResult.ok) {
    console.error('[fixed-timestep] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  buildFixedTimestepWorld(app.world);
  const started = app.start();
  if (!started.ok) console.error('[fixed-timestep] app.start() failed:', started.error);
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
bootstrap(canvas);
