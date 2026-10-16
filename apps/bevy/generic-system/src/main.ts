import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildGenericSystemWorld, readGenericSystemState } from './generic-system.js';

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[generic-system] createApp failed:', appResult.error);
    return;
  }

  const app = appResult.value;
  const state = buildGenericSystemWorld(app.world);
  globalThis.__bevyGenericSystemState = () => readGenericSystemState(app.world, state);
  globalThis.__prepareGenericSystemCapture = async () => {
    let snapshot = readGenericSystemState(app.world, state);
    for (let frame = 0; frame < 180 && !isCaptureReady(snapshot); frame += 1) {
      const updated = app.world.update(1 / 60);
      if (!updated.ok) throw updated.error;
      snapshot = readGenericSystemState(app.world, state);
    }
    if (!isCaptureReady(snapshot)) {
      throw new Error('generic-system capture preparation lost cleanup evidence: ' + JSON.stringify(snapshot));
    }
  };
  const started = app.start();
  if (!started.ok) {
    console.error('[generic-system] app.start() failed:', started.error);
    return;
  }
  globalThis.__bevyGenericSystemReady = true;
}

declare global {
  var __bevyGenericSystemReady: boolean | undefined;
  var __bevyGenericSystemState: (() => ReturnType<typeof readGenericSystemState>) | undefined;
  var __prepareGenericSystemCapture: (() => Promise<void>) | undefined;
}

function isCaptureReady(snapshot: ReturnType<typeof readGenericSystemState>): boolean {
  return (
    snapshot.currentState === 'menu' &&
    snapshot.cleanupLog.join(',') === 'menu-close,level-unload' &&
    snapshot.remaining === 1
  );
}

const canvas = document.getElementById('app') as HTMLCanvasElement | null;
if (!canvas) throw new Error('<canvas id="app"> not found');
bootstrap(canvas);
