import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { buildSystemParamWorld, readSystemParamState } from './system-param.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-system-param: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-system-param] no usable backend:', error);
  } else {
    console.error('[bevy-system-param] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-system-param] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildSystemParamWorld(app.world);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-system-param] app.start failed:', started.error);
    return;
  }
  const host = globalThis as {
    __bevySystemParamReady?: boolean;
    __bevySystemParamState?: () => ReturnType<typeof readSystemParamState>;
    __prepareSystemParamCapture?: () => Promise<void>;
  };
  host.__bevySystemParamState = () => readSystemParamState(app.world, state);
  host.__prepareSystemParamCapture = async () => {
    let snapshot = readSystemParamState(app.world, state);
    for (let frame = 0; frame < 180 && !isCaptureReady(snapshot); frame += 1) {
      const updated = app.world.update(1 / 60);
      if (!updated.ok) throw updated.error;
      snapshot = readSystemParamState(app.world, state);
    }
    if (!isCaptureReady(snapshot)) {
      throw new Error('system-param capture preparation lost system parameter evidence: ' + JSON.stringify(snapshot));
    }
  };
  host.__bevySystemParamReady = true;
}

function isCaptureReady(snapshot: ReturnType<typeof readSystemParamState>): boolean {
  return (
    snapshot.runs >= 1 &&
    snapshot.playerCount === 3 &&
    snapshot.resourceValue === 3 &&
    Number.isFinite(snapshot.counterX)
  );
}
