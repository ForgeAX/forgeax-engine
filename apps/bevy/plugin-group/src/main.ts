import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { helloWorldPlugins } from './plugin-group.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, { plugins: [helloWorldPlugins] }, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[plugin-group] createApp failed:', appResult.error);
    return;
  }
  const started = appResult.value.start();
  if (!started.ok) console.error('[plugin-group] app.start() failed:', started.error);
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
void bootstrap(canvas);
