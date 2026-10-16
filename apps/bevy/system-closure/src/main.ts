import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { buildSystemClosureWorld, readSystemClosureState } from './system-closure.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-system-closure: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-system-closure] no usable backend:', error);
  } else {
    console.error('[bevy-system-closure] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-system-closure] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildSystemClosureWorld(app.world);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-system-closure] app.start failed:', started.error);
    return;
  }
  const host = globalThis as {
    __bevySystemClosureReady?: boolean;
    __bevySystemClosureState?: () => ReturnType<typeof readSystemClosureState>;
    __prepareSystemClosureCapture?: () => Promise<void>;
  };
  host.__bevySystemClosureState = () => readSystemClosureState(app.world, state);
  host.__prepareSystemClosureCapture = async () => {
    let snapshot = readSystemClosureState(app.world, state);
    for (let frame = 0; frame < 180 && !isCaptureReady(snapshot); frame += 1) {
      const updated = app.world.update(1 / 60);
      if (!updated.ok) throw updated.error;
      snapshot = readSystemClosureState(app.world, state);
    }
    if (!isCaptureReady(snapshot)) {
      throw new Error('system-closure capture preparation lost closure evidence: ' + JSON.stringify(snapshot));
    }
  };
  host.__bevySystemClosureReady = true;
}

function isCaptureReady(snapshot: ReturnType<typeof readSystemClosureState>): boolean {
  return (
    snapshot.simpleRuns >= 1 &&
    snapshot.statefulRuns >= 1 &&
    snapshot.capturedRuns >= 1 &&
    snapshot.statefulValue === snapshot.statefulRuns &&
    snapshot.capturedValue > 7 &&
    [snapshot.simpleX, snapshot.statefulX, snapshot.capturedX].every(Number.isFinite)
  );
}
