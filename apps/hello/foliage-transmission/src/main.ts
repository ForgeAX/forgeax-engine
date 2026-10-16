import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildFoliageWorld, type FoliageMode } from './foliage';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-foliage-transmission: missing <canvas id="app">');

bootstrap(canvas).catch((error: unknown) => {
  if (error instanceof EngineEnvironmentError)
    console.error('[foliage-transmission] no usable backend:', error);
  else console.error('[foliage-transmission] bootstrap error:', error);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const result = await createApp(target, {}, forgeaxBundlerAdapter());
  if (!result.ok) {
    console.error('[foliage-transmission] createApp failed:', result.error);
    return;
  }
  const app = result.value;
  window.__foliageInspection = () => app.renderer.inspect().capabilities.backendKind;
  const params = new URLSearchParams(location.search);
  const mode: FoliageMode =
    params.get('mode') === 'no-transmission' ? 'no-transmission' : 'transmission';
  buildFoliageWorld(app.world, {
    aspect: target.width / Math.max(target.height, 1),
    mode,
    grid: Number.parseInt(params.get('grid') ?? '0', 10) || 0,
    pointLightCount: params.get('points') === '4' ? 4 : 1,
  });
  app.onError((error) => console.error('[foliage-transmission] app error:', error.code, error.hint));
  installCaptureHook(app, target);
  const started = app.start();
  if (!started.ok) console.error('[foliage-transmission] app.start failed:', started.error);
}

// Receipt-bound live read used by the RHI Debug pixel verifier: the canvas
// pixels come from the same frame that the capture records.
function installCaptureHook(app: App, target: HTMLCanvasElement): void {
  const renderer = app.renderer;
  const attached = renderer.attach(app.world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  window.__captureFoliage = async (): Promise<Uint8Array> => {
    app.world.update(1 / 60).unwrap();
    const frame = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!frame.ok) throw frame.error;
    const observed = await renderer.observe(frame.value, { include: ['draws'] });
    if (!observed.ok) throw observed.error;
    const pixels = await captureCanvasPixels(target);
    if (!pixels.ok)
      throw new Error(`[foliage-transmission] canvas capture failed: ${pixels.error.code}`);
    return pixels.value;
  };
}

declare global {
  interface Window {
    __captureFoliage?: () => Promise<Uint8Array>;
    __foliageInspection?: () => string;
  }
}
