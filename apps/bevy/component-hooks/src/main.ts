import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { buildComponentHooksWorld, readComponentHooksState } from './component-hooks.js';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-component-hooks: missing <canvas id="app"> in index.html');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError) {
    console.error('[bevy-component-hooks] no usable backend:', error);
  } else {
    console.error('[bevy-component-hooks] bootstrap error:', error);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-component-hooks] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildComponentHooksWorld(app.world);
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-component-hooks] app.start failed:', started.error);
    return;
  }
  const host = globalThis as {
    __bevyComponentHooksReady?: boolean;
    __bevyComponentHooksState?: () => ReturnType<typeof readComponentHooksState>;
    __prepareComponentHooksCapture?: () => Promise<void>;
  };
  host.__bevyComponentHooksState = () => readComponentHooksState(app.world, state);
  host.__prepareComponentHooksCapture = async () => {
    let snapshot = readComponentHooksState(app.world, state);
    for (let frame = 0; frame < 180 && !isCaptureReady(snapshot); frame += 1) {
      const updated = app.world.update(1 / 60);
      if (!updated.ok) throw updated.error;
      snapshot = readComponentHooksState(app.world, state);
    }
    if (!isCaptureReady(snapshot)) {
      throw new Error('component-hooks capture preparation lost lifecycle evidence: ' + JSON.stringify(snapshot));
    }
  };
  host.__bevyComponentHooksReady = true;
}

function isCaptureReady(snapshot: ReturnType<typeof readComponentHooksState>): boolean {
  return (
    snapshot.add === 2 &&
    snapshot.insert === 3 &&
    snapshot.discard === 2 &&
    snapshot.remove === 1 &&
    snapshot.indexSize === 1 &&
    snapshot.rekey === 3 &&
    snapshot.remaining === 0
  );
}
