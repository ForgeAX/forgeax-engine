import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { replayCapturedFrameInBrowser } from '@forgeax/apps-shared/rhi-debug-browser-replay';
import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildProjectionWorld } from './scene';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-material-projection: missing <canvas id="app">');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError)
    console.error('[material-projection] no usable backend:', error);
  else console.error('[material-projection] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) {
    console.error('[material-projection] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  buildProjectionWorld(app.world);
  app.onError((error) => console.error('[material-projection] app error:', error.code, error.hint));
  installCaptureHook(app, target);
  const started = app.start();
  if (!started.ok) console.error('[material-projection] app.start failed:', started.error);
}

// Receipt-bound live read used by the RHI Debug pixel verifier: the canvas
// pixels come from the same frame that the capture records.
function installCaptureHook(app: App, target: HTMLCanvasElement): void {
  const renderer = app.renderer;
  const attached = renderer.attach(app.world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  window.__captureProjection = async (): Promise<Uint8Array> => {
    app.world.update(1 / 60).unwrap();
    const frame = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!frame.ok) throw frame.error;
    const observed = await renderer.observe(frame.value, { include: ['draws'] });
    if (!observed.ok) throw observed.error;
    const pixels = await captureCanvasPixels(target);
    if (!pixels.ok)
      throw new Error(`[material-projection] canvas capture failed: ${pixels.error.code}`);
    return pixels.value;
  };
  window.__replayProjectionCapture = replayCapturedFrameInBrowser;
}

declare global {
  interface Window {
    __captureProjection?: () => Promise<Uint8Array>;
    __replayProjectionCapture?: typeof replayCapturedFrameInBrowser;
  }
}
