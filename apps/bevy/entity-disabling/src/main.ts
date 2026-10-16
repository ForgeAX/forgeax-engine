import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildEntityDisablingWorld, readEntityDisablingState } from './entity-disabling.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[entity-disabling] createApp failed:', appResult.error);
    return;
  }

  const app = appResult.value;
  const state = buildEntityDisablingWorld(app.world);
  globalThis.__bevyEntityDisablingState = () => readEntityDisablingState(app.world, state);
  const started = app.start();
  if (!started.ok) {
    console.error('[entity-disabling] app.start() failed:', started.error);
    return;
  }
  globalThis.__bevyEntityDisablingReady = true;
}

declare global {
  var __bevyEntityDisablingReady: boolean | undefined;
  var __bevyEntityDisablingState:
    | (() => ReturnType<typeof readEntityDisablingState>)
    | undefined;
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
bootstrap(canvas);
