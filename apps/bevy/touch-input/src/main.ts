import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { FRAME_START_SCAN_SYSTEM_NAME, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { buildTouchInputWorld, stepTouchInput } from './touch-input';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('bevy-touch-input: missing <canvas id="app"> in index.html');

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appResult = await createApp(target, { pointerLockAllowed: () => false }, forgeaxBundlerAdapter());
  if (!appResult.ok) {
    console.error('[bevy-touch-input] createApp failed:', appResult.error);
    return;
  }
  const app = appResult.value;
  const state = buildTouchInputWorld(app.world);
  app.world.addSystem(Update, {
    name: 'bevy-touch-input-read',
    after: [FRAME_START_SCAN_SYSTEM_NAME],
    queries: [],
    fn: (world) => stepTouchInput(world, world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)),
  });
  const started = app.start();
  if (!started.ok) {
    console.error('[bevy-touch-input] app.start failed:', started.error.code, started.error.hint);
    return;
  }
  console.warn(`[bevy-touch-input] state=${app.renderer.inspect().state}`);
  Object.assign(globalThis, { __bevyTouchInputReady: true, __bevyTouchInputState: state });
}

bootstrap(canvas).catch((error: unknown) => console.error('[bevy-touch-input] bootstrap error:', error));
